/* eslint-disable */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { getFirestore } = require("firebase-admin/firestore");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const cors = require("cors")({ origin: true });

const nodemailer = require("nodemailer");
const crypto = require("crypto");

admin.initializeApp();
// All data lives in the Australian Firestore database
const db = getFirestore(admin.app(), "mymor-australia");

// ========== Email ==========

const SMTP_HOST = defineSecret("SMTP_HOST");
const SMTP_PORT = defineSecret("SMTP_PORT");
const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const OTP_SECRET = defineSecret("OTP_SECRET");

function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}
function validateEmail(email) {
  const re = /\S+@\S+\.\S+/;
  return re.test(email);
}
function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function otpHash(email, code, otpSecret) {
  return sha256(`${String(email).toLowerCase().trim()}:${code}:${otpSecret}`);
}
let smtpTransporter = null;
function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter;

  const host = String(SMTP_HOST.value() || "").trim(); // smtp.titan.email
  const port = Number(String(SMTP_PORT.value() || "").trim()); // 465
  const user = String(SMTP_USER.value() || "").trim();
  const pass = String(SMTP_PASS.value() || "").trim();

  const secure = port === 465;
  smtpTransporter = nodemailer.createTransport({
    host: "smtpout.secureserver.net",
    port: 465,
    secure: true, // IMPORTANT
    auth: {
      user: SMTP_USER.value(),
      pass: SMTP_PASS.value(),
    },
    pool: true,
    maxConnections: 1,
    maxMessages: 5,
  });

  return smtpTransporter;
}

exports.sendVerificationCode = onRequest(
  {
    region: "us-central1",
    secrets: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, OTP_SECRET],
  },
  (req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method === "OPTIONS") return res.status(204).send("");
        if (req.method !== "POST") {
          return res.status(405).json({ error: { message: "Method Not Allowed" } });
        }

        const email = String(req.body.email || "").toLowerCase().trim();
        if (!validateEmail(email)) {
          return res.status(400).json({ error: { message: "Invalid email" } });
        }

        // Create code + requestId
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const requestId = crypto.randomUUID();

        const otpSecret = OTP_SECRET.value();
        if (!otpSecret) throw new Error("OTP_SECRET not configured");

        const codeHash = otpHash(email, code, otpSecret);
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min

        // Save OTP in Firestore (mymor-australia)
        await db.collection("emailOtps").doc(requestId).set({
          email,
          codeHash,
          expiresAt,
          attempts: 0,
          used: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Send email
        const transporter = getSmtpTransporter();
        await withTimeout(transporter.verify(), 8000, "SMTP verify timeout");
        await withTimeout(
          transporter.sendMail({
            from: `MyMor <${SMTP_USER.value()}>`,
            to: email,
            subject: "Your MyMor verification code",
            text: `Your MyMor verification code is ${code}. It expires in 5 minutes.`,
          }),
          15000,
          "SMTP send timeout"
        );

        return res.status(200).json({ success: true, requestId });
      } catch (err) {
        console.error("sendVerificationCode error:", err);
        return res.status(500).json({ error: { message: err.message || "Failed to send code" } });
      }
    });
  }
);

// ================== VERIFY OTP ==================
exports.verifyEmailCode = onRequest(
  { region: "us-central1", secrets: [OTP_SECRET] },
  (req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method === "OPTIONS") return res.status(204).send("");
        if (req.method !== "POST") {
          return res.status(405).json({ error: { message: "Method Not Allowed" } });
        }

        const email = String(req.body.email || "").trim().toLowerCase();
        const code = String(req.body.code || "").trim();
        const requestId = String(req.body.requestId || "").trim();

        if (!validateEmail(email) || code.length !== 6 || !requestId) {
          return res.status(400).json({ error: { message: "Invalid payload" } });
        }

        const otpSecret = OTP_SECRET.value();
        if (!otpSecret) throw new Error("OTP_SECRET not configured");

        const ref = db.collection("emailOtps").doc(requestId);
        const snap = await ref.get();

        if (!snap.exists) {
          return res.status(400).json({ error: { message: "Invalid requestId" } });
        }

        const data = snap.data() || {};

        if (data.used) return res.status(400).json({ error: { message: "Code already used" } });
        if (data.email !== email) return res.status(400).json({ error: { message: "Email mismatch" } });
        if (Date.now() > Number(data.expiresAt || 0)) return res.status(400).json({ error: { message: "Code expired" } });

        const attempts = Number(data.attempts || 0);
        if (attempts >= 5) return res.status(429).json({ error: { message: "Too many attempts" } });

        const ok = otpHash(email, code, otpSecret) === data.codeHash;
        if (!ok) {
          await ref.update({ attempts: admin.firestore.FieldValue.increment(1) });
          return res.status(400).json({ error: { message: "Invalid code" } });
        }

        await ref.update({
          used: true,
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // OTP verified — app handles account creation itself (createUserWithEmailAndPassword)
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("verifyEmailCode error:", err);
        return res.status(500).json({ error: { message: err.message || "Verification failed" } });
      }
    });
  }
);

// ========== FCM Token helpers (Firestore-backed) ==========

/**
 * Get all FCM tokens for every user in a hostel, optionally excluding one uid.
 * Firestore path: hostelTokens/{hostelid}/tokens/{uid}
 */
async function tokensForHostel(hostelid, excludeUid = null) {
  if (!hostelid) return [];
  const snap = await db
    .collection("hostelTokens")
    .doc(hostelid)
    .collection("tokens")
    .get();

  const tokens = [];
  snap.forEach((doc) => {
    if (excludeUid && doc.id === String(excludeUid)) return;
    const v = doc.data() || {};
    if (v.token) tokens.push(v.token);
    if (Array.isArray(v.tokens)) tokens.push(...v.tokens.filter(Boolean));
  });

  return Array.from(new Set(tokens.filter(Boolean)));
}

/**
 * Get FCM tokens for a specific user scoped to a hostel.
 * Firestore path: hostelTokens/{hostelid}/tokens/{uid}
 */
async function tokensForUser(hostelid, uid) {
  if (!hostelid || !uid) return [];
  const docSnap = await db
    .collection("hostelTokens")
    .doc(hostelid)
    .collection("tokens")
    .doc(uid)
    .get();

  if (!docSnap.exists) return [];
  const v = docSnap.data() || {};
  let tokens = [];
  if (v.token) tokens.push(v.token);
  if (Array.isArray(v.tokens)) tokens.push(...v.tokens);
  return Array.from(new Set(tokens.filter(Boolean)));
}

/**
 * Get FCM tokens for all members of a group (excluding sender).
 * Firestore path: groups/{groupId}/members/{uid}
 */
async function tokensForGroupMembers(hostelid, groupId, excludeUid = null) {
  const snap = await db
    .collection("groups")
    .doc(groupId)
    .collection("members")
    .get();

  const memberUids = [];
  snap.forEach((doc) => {
    if (doc.id && doc.id !== String(excludeUid)) memberUids.push(doc.id);
  });

  const tokenSets = await Promise.all(
    memberUids.map((uid) => tokensForUser(hostelid, uid))
  );
  const all = tokenSets.flat().filter(Boolean);
  return Array.from(new Set(all));
}

/**
 * Get FCM tokens for a user by their uid (not hostel-scoped).
 * Firestore path: userTokens/{uid}
 */
async function tokensForUserId(uid) {
  if (!uid) return [];
  const docSnap = await db.collection("userTokens").doc(uid).get();
  if (!docSnap.exists) return [];
  const v = docSnap.data() || {};
  let tokens = [];
  if (v.token) tokens.push(v.token);
  if (Array.isArray(v.tokens)) tokens.push(...v.tokens.filter(Boolean));
  // also collect any string values directly on the doc
  Object.values(v).forEach((maybe) => {
    if (typeof maybe === "string" && maybe) tokens.push(maybe);
    if (Array.isArray(maybe)) tokens.push(...maybe.filter(Boolean));
  });
  return Array.from(new Set(tokens.filter(Boolean)));
}

// ========== Notification Settings helpers ==========

/**
 * Load a user's notification settings from Firestore.
 * Firestore path: notificationSettings/{uid}
 */
async function getUserNotificationSettings(uid) {
  const docSnap = await db.collection("notificationSettings").doc(uid).get();
  const val = docSnap.exists ? docSnap.data() || {} : {};

  const globalEnabled =
    !val.global || val.global.enabled !== false; // default: true

  const channels = val.channels || {};
  const mutedGroups = val.mutedGroups || {};

  return { globalEnabled, channels, mutedGroups };
}

async function isNotificationsEnabledFor(uid, opts) {
  const { channel, groupId, communityId, discoverGroupId } = opts || {};
  const s = await getUserNotificationSettings(uid);

  // 1) Global switch
  if (!s.globalEnabled) return false;

  // 2) Channel switch (if explicitly false then off)
  if (
    channel &&
    Object.prototype.hasOwnProperty.call(s.channels, channel) &&
    s.channels[channel] === false
  ) {
    return false;
  }

  // 3) Per-group mute
  const mg = s.mutedGroups || {};

  if (channel === "chat" && groupId) {
    if (mg.chat && mg.chat[groupId] && mg.chat[groupId].muted) return false;
  }

  if (channel === "community" && communityId) {
    if (mg.community && mg.community[communityId] && mg.community[communityId].muted)
      return false;
  }

  if (channel === "discoverAnnouncements" && discoverGroupId) {
    if (
      mg.discover &&
      mg.discover[discoverGroupId] &&
      mg.discover[discoverGroupId].muted
    )
      return false;
  }

  return true;
}

/**
 * Collect tokens for discover-group announcement recipients (respects mute settings).
 * Firestore path: discovergroup/{groupId}/members/{uid}
 */
async function tokensForDiscoverGroupMembersWithSettings(groupId, senderUid) {
  if (!groupId) return [];

  const snap = await db
    .collection("discovergroup")
    .doc(groupId)
    .collection("members")
    .get();

  const memberUids = [];
  snap.forEach((doc) => {
    if (doc.id && doc.id !== String(senderUid)) memberUids.push(doc.id);
  });
  if (!memberUids.length) return [];

  const tokenSets = await Promise.all(
    memberUids.map(async (uid) => {
      const enabled = await isNotificationsEnabledFor(uid, {
        channel: "discoverAnnouncements",
        discoverGroupId: groupId,
      });
      if (!enabled) return [];
      return tokensForUserId(uid);
    })
  );

  const all = tokenSets.flat().filter(Boolean);
  return Array.from(new Set(all));
}

/**
 * Collect tokens for discover-group chat recipients (respects mute settings).
 * Firestore path: discovergroup/{groupId}/members/{uid}
 */
async function tokensForDiscoverGroupChatMembers(groupId, senderUid) {
  if (!groupId) return [];

  const snap = await db
    .collection("discovergroup")
    .doc(groupId)
    .collection("members")
    .get();

  const memberUids = [];
  snap.forEach((doc) => {
    if (doc.id && doc.id !== String(senderUid)) memberUids.push(doc.id);
  });
  if (!memberUids.length) return [];

  const tokenSets = await Promise.all(
    memberUids.map(async (uid) => {
      const enabled = await isNotificationsEnabledFor(uid, {
        channel: "chat",
        groupId,
      });
      if (!enabled) return [];
      return tokensForUserId(uid);
    })
  );

  const all = tokenSets.flat().filter(Boolean);
  return Array.from(new Set(all));
}

// ========== Group chat ==========
exports.sendGroupMessageNotification = onDocumentCreated(
  { document: "groups/{groupId}/messages/{messageId}", database: "mymor-australia" },
  async (event) => {
    const { groupId } = event.params;
    const messageData = event.data.data() || {};

    const groupName = messageData.groupName || "";
    const senderId = messageData.senderId || "";
    const senderName = messageData.sender || "Someone";
    const messageText = messageData.text || "";
    const type = messageData.type || "";
    const posterUrl = messageData.posterUrl || "";

    // Resolve hostelid (prefer message, fallback to group doc)
    let hostelid = messageData.hostelid;
    if (!hostelid) {
      const gSnap = await db.collection("groups").doc(groupId).get();
      hostelid = (gSnap.data() || {}).hostelid || "";
    }

    // Only notify group members (exclude sender)
    const tokens = await tokensForGroupMembers(hostelid, groupId, senderId);
    if (!tokens.length) {
      console.log("[sendGroupMessageNotification] No member tokens found");
      return null;
    }

    const body =
      !type || type === "text"
        ? `${senderName}: ${messageText || "Sent a message"}`
        : `${senderName} ${{
            image: "sent an image",
            audio: "sent a voice message",
            video: "sent a video",
            event: "created an event",
            poll: "created a poll",
          }[type] || "sent a message"}`;

    const base = {
      notification: { title: groupName || "New message", body },
      data: {
        screen: "GroupChat",
        type: "groupMessage",
        groupId,
        groupName,
        senderId: senderId || "",
        senderName,
        messageType: type,
        messageText,
        posterUrl,
        hostelid: hostelid || "",
      },
    };

    const chunkSize = 500;
    try {
      let success = 0,
        failure = 0;
      for (let i = 0; i < tokens.length; i += chunkSize) {
        const resp = await admin
          .messaging()
          .sendEachForMulticast({ tokens: tokens.slice(i, i + chunkSize), ...base });
        success += resp.successCount;
        failure += resp.failureCount;
      }
      console.log(
        `[sendGroupMessageNotification] success=${success} failure=${failure} total=${tokens.length}`
      );
      return { success, failure, total: tokens.length };
    } catch (error) {
      console.error("[sendGroupMessageNotification] FCM error:", error);
      return null;
    }
  }
);

// ========== Announcements: comment ==========
exports.sendAnnouncementsCommentNotification = onDocumentCreated(
  {
    document: "announcements/{announcementId}/comments/{commentId}",
    database: "mymor-australia",
  },
  async (event) => {
    const comment = event.data.data() || {};
    const { announcementId } = event.params;
    const title = comment.title;
    const senderId = comment.senderId;
    const senderName = comment.sender || "Someone";
    const messageText = comment.content || "";

    const announcementSnap = await db
      .collection("announcements")
      .doc(announcementId)
      .get();
    const announcement = announcementSnap.data() || {};

    if (!announcement || senderId === announcement.userId) return null;

    const hostelid = announcement.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens.length) return null;

    const payload = {
      notification: {
        title: title || announcement.title || "Announcement",
        body: `${senderName}: ${messageText}`,
      },
      data: {
        screen: "AnnouncementDetail",
        announcementId,
        title: title || "",
        senderId: senderId || "",
        senderName,
        messageText,
        hostelid: hostelid || "",
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload,
      });
      console.log(`${response.successCount} messages were sent successfully`);
      return response;
    } catch (error) {
      console.error("Error sending notification:", error);
      return null;
    }
  }
);

// ========== Announcements: reply ==========
exports.sendAnnouncementsReplyNotification = onDocumentCreated(
  {
    document:
      "announcements/{announcementId}/comments/{commentId}/replies/{replyId}",
    database: "mymor-australia",
  },
  async (event) => {
    const reply = event.data.data() || {};
    const { announcementId, commentId } = event.params;
    const title = reply.title;
    const senderId = reply.senderId;
    const senderName = reply.sender || "Someone";
    const messageText = reply.content || "";

    const commentSnap = await db
      .collection("announcements")
      .doc(announcementId)
      .collection("comments")
      .doc(commentId)
      .get();
    const comment = commentSnap.data() || {};
    if (!comment || senderId === comment.uid) return null;

    const annSnap = await db.collection("announcements").doc(announcementId).get();
    const announcement = annSnap.data() || {};

    const hostelid = announcement.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens || !tokens.length) return null;

    const payload = {
      notification: {
        title: title || announcement.title || "Announcement",
        body: `${senderName}: ${messageText}`,
      },
      data: {
        screen: "AnnouncementDetail",
        announcementId,
        title: title || "",
        senderId: senderId || "",
        senderName,
        messageText,
        commentId,
        hostelid: hostelid || "",
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload,
      });
      console.log(`${response.successCount} messages were sent successfully`);
      return response;
    } catch (error) {
      console.error("Error sending notification:", error);
      return null;
    }
  }
);

// ========== Community: new post ==========
exports.sendCommunitynNewPostNotification = onDocumentCreated(
  { document: "community/{postId}", database: "mymor-australia" },
  async (event) => {
    const post = event.data.data() || {};
    const { postId } = event.params;
    const senderId = post.senderId;
    const senderName = post.sender || "Someone";
    const messageText = post.content || "";

    if (!post || !post.content || !post.senderId) return null;

    const hostelid = post.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens || !tokens.length) return null;

    const payload = {
      notification: {
        title: senderName,
        body: `${senderName}: ${String(messageText).slice(0, 100)}`,
      },
      data: {
        screen: "Community",
        postId,
        type: "new_post",
        hostelid: hostelid || "",
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload,
      });
      console.log(`${response.successCount} messages were sent successfully`);
      return response;
    } catch (error) {
      console.error("Error sending notification:", error);
      return null;
    }
  }
);

// ========== Community: comment ==========
exports.sendCommunityCommentNotification = onDocumentCreated(
  { document: "community/{postId}/comments/{commentId}", database: "mymor-australia" },
  async (event) => {
    const comment = event.data.data() || {};
    const { postId } = event.params;
    const senderId = comment.senderId;
    const senderName = comment.sender || "Someone";
    const messageText = comment.content || "";

    const communitySnap = await db.collection("community").doc(postId).get();
    const post = communitySnap.data() || {};
    if (!post || comment.senderId === post.uid) return null;

    const hostelid = post.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens || !tokens.length) return null;

    const payload = {
      notification: {
        title: senderName,
        body: `${senderName}: ${messageText}`,
      },
      data: {
        screen: "Community",
        postId,
        type: "comment",
        hostelid: hostelid || "",
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload,
      });
      console.log(`${response.successCount} messages were sent successfully`);
      return response;
    } catch (error) {
      console.error("Error sending notification:", error);
      return null;
    }
  }
);

// ========== Community: reply ==========
exports.sendCommunityReplyNotification = onDocumentCreated(
  {
    document: "community/{postId}/comments/{commentId}/replies/{replyId}",
    database: "mymor-australia",
  },
  async (event) => {
    const reply = event.data.data() || {};
    const { postId, commentId } = event.params;
    const senderId = reply.senderId;
    const senderName = reply.sender || "Someone";
    const messageText = reply.content || "";

    const commentSnap = await db
      .collection("community")
      .doc(postId)
      .collection("comments")
      .doc(commentId)
      .get();
    const comment = commentSnap.data() || {};
    if (!comment || senderId === comment.uid) return null;

    const postSnap = await db.collection("community").doc(postId).get();
    const post = postSnap.data() || {};

    const hostelid = post.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens || !tokens.length) return null;

    const payload = {
      notification: {
        title: senderName,
        body: `${senderName}: ${messageText}`,
      },
      data: {
        screen: "Community",
        postId,
        commentId,
        type: "reply",
        hostelid: hostelid || "",
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload,
      });
      console.log(`${response.successCount} messages were sent successfully`);
      return response;
    } catch (error) {
      console.error("Error sending notification:", error);
      return null;
    }
  }
);

// ========== Dining menu: existing entry updated ==========
exports.sendMenuChangedNotification = onDocumentUpdated(
  { document: "menus/{menuDate}", database: "mymor-australia" },
  async (event) => {
    const menuDate = event.params.menuDate;
    const beforeData = event.data.before.data() || {};
    const afterData = event.data.after.data() || {};

    if (JSON.stringify(beforeData) === JSON.stringify(afterData)) {
      console.log("No actual changes in the menu. Skipping notification.");
      return null;
    }

    const hostelid = afterData.hostelid || beforeData.hostelid;
    const tokens = await tokensForHostel(hostelid);
    if (!tokens || !tokens.length) {
      console.log("No FCM tokens found for hostel:", hostelid);
      return null;
    }

    const payload = {
      notification: {
        title: "Dining Menu Updated",
        body: `The menu for ${menuDate} has been updated. Check it out!`,
      },
      data: {
        screen: "DiningMenu",
        type: "menuUpdate",
        menuDate: String(menuDate),
        hostelid: hostelid || "",
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload,
      });
      console.log(
        `${response.successCount} menu notifications sent successfully.`
      );
      return response;
    } catch (error) {
      console.error("Error sending menu update notification:", error);
      return null;
    }
  }
);

// ========== Dining Menu: new upload notification ==========
exports.sendMenuUpdateNotification = onDocumentCreated(
  { document: "menus_uploads/{uploadId}", database: "mymor-australia" },
  async (event) => {
    const data = event.data.data() || {};
    const hostelid = data.hostelid;
    const createdCount = Number(data.createdCount || 0);
    const firstDate = data.firstDate || "";
    const lastDate = data.lastDate || "";

    if (!hostelid || !createdCount) {
      console.log("[sendMenuUpdateNotification] Missing hostelid/createdCount, skipping.");
      return null;
    }

    const tokens = await tokensForHostel(hostelid);
    if (!tokens || !tokens.length) {
      console.log("[sendMenuUpdateNotification] No FCM tokens found for hostel:", hostelid);
      return null;
    }

    const rangeLabel =
      firstDate && lastDate && firstDate !== lastDate
        ? `${firstDate} → ${lastDate}`
        : firstDate || lastDate || "upcoming days";

    const payload = {
      notification: {
        title: "Dining Menu Updated",
        body: `New dining menu uploaded for ${rangeLabel}.`,
      },
      data: {
        screen: "DiningMenu",
        type: "menuUpload",
        hostelid: hostelid || "",
        firstDate: String(firstDate || ""),
        lastDate: String(lastDate || ""),
        createdCount: String(createdCount),
      },
    };

    const chunkSize = 500;
    let success = 0;
    let failure = 0;

    for (let i = 0; i < tokens.length; i += chunkSize) {
      const batch = tokens.slice(i, i + chunkSize);
      const resp = await admin.messaging().sendEachForMulticast({
        tokens: batch,
        ...payload,
      });
      success += resp.successCount;
      failure += resp.failureCount;
    }

    console.log(
      `[sendMenuUpdateNotification] Sent dining upload notification to hostel=${hostelid}, ` +
        `createdCount=${createdCount}, success=${success}, failure=${failure}, totalTokens=${tokens.length}`
    );

    return null;
  }
);

// ========== Admin HTTP endpoints (unchanged) ==========
exports.deleteUserByUid = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });
      }

      const { uid } = req.body || {};
      if (typeof uid !== "string" || !uid.trim()) {
        return res
          .status(400)
          .json({ error: "Request body must contain { uid: <string> }" });
      }
      await admin.auth().deleteUser(uid);
      return res
        .status(200)
        .json({ success: true, message: `User ${uid} deleted.` });
    } catch (err) {
      console.error("deleteUserByUid:", err);
      if (err.code === "auth/user-not-found") {
        return res.status(404).json({ error: "User not found" });
      }
      return res.status(500).json({ error: err.message });
    }
  });
});

// ========== Announcements: new announcement ==========
exports.sendAnnouncementsNewNotification = onDocumentCreated(
  { document: "announcements/{announcementId}", database: "mymor-australia" },
  async (event) => {
    const data = event.data.data() || {};
    const senderId = data.uid;
    const senderName = data.user || "Someone";
    const messageText = data.title || "New announcement";

    const hostelid = data.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens || !tokens.length) return null;

    const payload = {
      notification: {
        title: "New Announcement",
        body: `${senderName}: ${messageText}`,
      },
      data: {
        screen: "AnnouncementDetail",
        type: "new_announcement",
        title: data.title || "",
        announcementId: event.params.announcementId,
        hostelid: hostelid || "",
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload,
      });
      console.log(`${response.successCount} notifications sent.`);
      return response;
    } catch (error) {
      console.error("Error sending notification:", error);
      return null;
    }
  }
);

exports.disableUserByUid = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });
      }

      const { uid } = req.body;
      if (!uid || typeof uid !== "string") {
        return res
          .status(400)
          .json({ error: "Request body must contain { uid: <string> }" });
      }

      await admin.auth().updateUser(uid, { disabled: true });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("disableUserByUid error:", err);
      return res.status(500).json({ error: err.message });
    }
  });
});

exports.enableUserByUid = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });
      }

      const { uid } = req.body;
      if (!uid || typeof uid !== "string") {
        return res
          .status(400)
          .json({ error: "Request body must contain { uid: <string> }" });
      }

      await admin.auth().updateUser(uid, { disabled: false });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("enableUserByUid error:", err);
      return res.status(500).json({ error: err.message });
    }
  });
});

/* ================== DISABLE / ENABLE HOSTEL (doc.id === Auth UID) ================== */
/* eslint-disable no-console */

const EMP_COLLECTION = "employees";

// ---------- helpers ----------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function norm(val) {
  if (val == null) return "";
  return String(val).toLowerCase().replace(/[^a-z]/g, "");
}

function isSuperadminDoc(d) {
  d = d || {};
  var cand = [d.role, d.type, d.userRole, d.user_type];
  for (var i = 0; i < cand.length; i++) {
    if (norm(cand[i]) === "superadmin") return true;
  }
  if (Array.isArray(d.roles)) {
    for (var j = 0; j < d.roles.length; j++) {
      if (norm(d.roles[j]) === "superadmin") return true;
    }
  }
  if (d.roles && typeof d.roles === "object" && !Array.isArray(d.roles)) {
    for (var k in d.roles) {
      if (Object.prototype.hasOwnProperty.call(d.roles, k)) {
        if (norm(k) === "superadmin" && !!d.roles[k]) return true;
      }
    }
  }
  if (d.isSuperadmin === true || d.is_superadmin === true) return true;
  return false;
}

function isSuperadminClaims(claims) {
  claims = claims || {};
  if (norm(claims.role) === "superadmin" || norm(claims.type) === "superadmin")
    return true;

  if (Array.isArray(claims.roles)) {
    for (var i = 0; i < claims.roles.length; i++) {
      if (norm(claims.roles[i]) === "superadmin") return true;
    }
  }
  if (
    claims.roles &&
    typeof claims.roles === "object" &&
    !Array.isArray(claims.roles)
  ) {
    for (var k in claims.roles) {
      if (Object.prototype.hasOwnProperty.call(claims.roles, k)) {
        if (norm(k) === "superadmin" && !!claims.roles[k]) return true;
      }
    }
  }
  if (claims.isSuperadmin === true || claims.is_superadmin === true)
    return true;
  return false;
}

async function findSuperadminUIDsByClaims(uids) {
  const auth = admin.auth();
  const result = new Set();

  for (const group of chunk(uids, 50)) {
    const users = await Promise.all(
      group.map(function (uid) {
        return auth.getUser(uid).then(
          function (u) {
            return u;
          },
          function () {
            return null;
          }
        );
      })
    );
    users.forEach(function (u) {
      if (u && isSuperadminClaims(u.customClaims || {})) {
        result.add(u.uid);
      }
    });
    await new Promise(function (r) {
      setTimeout(r, 100);
    });
  }
  return result;
}

function toUidSet(arr) {
  if (!Array.isArray(arr)) return new Set();
  return new Set(
    arr.map(function (x) {
      return String(x).trim();
    }).filter(Boolean)
  );
}

// Collect employees linked to a hostel across common schema variants
async function collectEmployeesForHostel(hostelid) {
  const col = db.collection(EMP_COLLECTION);
  const hostRef = db.collection("hostel").doc(hostelid);

  const seen = new Set();
  const docs = [];

  async function run(q) {
    try {
      const snap = await q.get();
      snap.forEach(function (d) {
        const key = d.ref.path;
        if (!seen.has(key)) {
          seen.add(key);
          docs.push(d);
        }
      });
    } catch (e) {
      console.warn(
        "collectEmployeesForHostel query skipped:",
        e && e.message ? e.message : String(e)
      );
    }
  }

  await run(col.where("hostelid", "==", hostelid));
  await run(col.where("hostelId", "==", hostelid));
  await run(col.where("hostel_id", "==", hostelid));
  await run(col.where("hostelIds", "array-contains", hostelid));
  await run(col.where("hostel.id", "==", hostelid));
  await run(col.where("hostelRef", "==", hostRef));

  return docs;
}

// ---------- endpoints (v1) ----------
exports.disableHostelAndLockEmployees = functions.https.onRequest(function (
  req,
  res
) {
  cors(req, res, async function () {
    try {
      if (req.method !== "POST")
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });

      const body = req.body || {};
      const hostelid = body.hostelid;
      const reason = body.reason || "Disabled by admin action";
      const excludeUids = Array.isArray(body.excludeUids) ? body.excludeUids : [];

      if (!hostelid || typeof hostelid !== "string") {
        return res
          .status(400)
          .json({ error: "Request must include { hostelid: <string> }" });
      }

      const FieldValue = admin.firestore.FieldValue;
      const skipUidSet = toUidSet(excludeUids);

      // 1) Mark hostel disabled
      await db.collection("hostel").doc(hostelid).set(
        {
          active: false,
          lockedAt: FieldValue.serverTimestamp(),
          lockedBy: "http",
          disabledReason: reason,
        },
        { merge: true }
      );

      // 2) Collect employees
      let empDocs = await collectEmployeesForHostel(hostelid);

      let uids = [];
      let skippedSuperadmins = 0;
      let skippedByUid = 0;

      empDocs = empDocs.filter(function (docSnap) {
        const d = docSnap.data() || {};
        const duid = String(docSnap.id);

        if (skipUidSet.has(duid)) {
          skippedByUid++;
          return false;
        }
        if (isSuperadminDoc(d)) {
          skippedSuperadmins++;
          return false;
        }

        uids.push(duid);
        return true;
      });

      // claims-level skip
      const claimSupers = await findSuperadminUIDsByClaims(uids);
      if (claimSupers.size) {
        claimSupers.forEach(function (uid) {
          skipUidSet.add(uid);
        });
        skippedSuperadmins += claimSupers.size;

        empDocs = empDocs.filter(function (ds) {
          return !skipUidSet.has(String(ds.id));
        });
        uids = uids.filter(function (uid) {
          return !skipUidSet.has(uid);
        });
      }

      // 3) Firestore batched updates
      let fsCount = 0;
      for (const group of chunk(empDocs, 450)) {
        const batch = db.batch();
        group.forEach(function (ds) {
          batch.set(
            ds.ref,
            {
              active: false,
              lockedAt: FieldValue.serverTimestamp(),
              lockedBy: "http",
              lockedNote: reason,
            },
            { merge: true }
          );
        });
        await batch.commit();
        fsCount += group.length;
      }

      // 4) Auth disable
      let authCount = 0;
      for (const group of chunk(uids, 50)) {
        await Promise.all(
          group.map(function (uid) {
            return admin
              .auth()
              .updateUser(uid, { disabled: true })
              .then(function () {
                authCount++;
              })
              .catch(function (e) {
                console.error(
                  "Auth disable failed for",
                  uid,
                  e && e.message ? e.message : String(e)
                );
              });
          })
        );
        await new Promise(function (r) {
          setTimeout(r, 150);
        });
      }

      console.log(
        "[disableHostelAndLockEmployees]",
        "hostel:",
        hostelid,
        "docs:",
        empDocs.length,
        "uids:",
        uids.length,
        "skippedSuperadmins:",
        skippedSuperadmins,
        "skippedByUid:",
        skippedByUid
      );

      return res.status(200).json({
        success: true,
        hostelid: hostelid,
        firestoreUpdatedEmployees: fsCount,
        authDisabledUsers: authCount,
        skippedSuperadmins: skippedSuperadmins,
        skippedByUid: skippedByUid,
      });
    } catch (err) {
      console.error(
        "disableHostelAndLockEmployees error:",
        err && err.message ? err.message : String(err)
      );
      return res.status(500).json({
        error: err && err.message ? err.message : "Internal error",
      });
    }
  });
});

exports.enableHostelAndEmployees = functions.https.onRequest(function (req, res) {
  cors(req, res, async function () {
    try {
      if (req.method !== "POST")
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });

      const body = req.body || {};
      const hostelid = body.hostelid;
      const reason = body.reason || "Enabled by admin action";
      const excludeUids = Array.isArray(body.excludeUids) ? body.excludeUids : [];

      if (!hostelid || typeof hostelid !== "string") {
        return res
          .status(400)
          .json({ error: "Request must include { hostelid: <string> }" });
      }

      const FieldValue = admin.firestore.FieldValue;
      const skipUidSet = toUidSet(excludeUids);

      // 1) Mark hostel enabled
      await db.collection("hostel").doc(hostelid).set(
        {
          active: true,
          unlockedAt: FieldValue.serverTimestamp(),
          unlockedBy: "http",
          enabledReason: reason,
        },
        { merge: true }
      );

      // 2) Collect employees
      let empDocs = await collectEmployeesForHostel(hostelid);

      let uids = [];
      let skippedSuperadmins = 0;
      let skippedByUid = 0;

      empDocs = empDocs.filter(function (docSnap) {
        const d = docSnap.data() || {};
        const duid = String(docSnap.id);

        if (skipUidSet.has(duid)) {
          skippedByUid++;
          return false;
        }
        if (isSuperadminDoc(d)) {
          skippedSuperadmins++;
          return false;
        }

        uids.push(duid);
        return true;
      });

      const claimSupers = await findSuperadminUIDsByClaims(uids);
      if (claimSupers.size) {
        claimSupers.forEach(function (uid) {
          skipUidSet.add(uid);
        });
        skippedSuperadmins += claimSupers.size;

        empDocs = empDocs.filter(function (ds) {
          return !skipUidSet.has(String(ds.id));
        });
        uids = uids.filter(function (uid) {
          return !skipUidSet.has(uid);
        });
      }

      // 3) Firestore batched updates
      let fsCount = 0;
      for (const group of chunk(empDocs, 450)) {
        const batch = db.batch();
        group.forEach(function (ds) {
          batch.set(
            ds.ref,
            {
              active: true,
              unlockedAt: FieldValue.serverTimestamp(),
              unlockedBy: "http",
              unlockedNote: reason,
            },
            { merge: true }
          );
        });
        await batch.commit();
        fsCount += group.length;
      }

      // 4) Auth enable
      let authCount = 0;
      for (const group of chunk(uids, 50)) {
        await Promise.all(
          group.map(function (uid) {
            return admin
              .auth()
              .updateUser(uid, { disabled: false })
              .then(function () {
                authCount++;
              })
              .catch(function (e) {
                console.error(
                  "Auth enable failed for",
                  uid,
                  e && e.message ? e.message : String(e)
                );
              });
          })
        );
        await new Promise(function (r) {
          setTimeout(r, 150);
        });
      }

      console.log(
        "[enableHostelAndEmployees]",
        "hostel:",
        hostelid,
        "docs:",
        empDocs.length,
        "uids:",
        uids.length,
        "skippedSuperadmins:",
        skippedSuperadmins,
        "skippedByUid:",
        skippedByUid
      );

      return res.status(200).json({
        success: true,
        hostelid: hostelid,
        firestoreUpdatedEmployees: fsCount,
        authEnabledUsers: authCount,
        skippedSuperadmins: skippedSuperadmins,
        skippedByUid: skippedByUid,
      });
    } catch (err) {
      console.error(
        "enableHostelAndEmployees error:",
        err && err.message ? err.message : String(err)
      );
      return res.status(500).json({
        error: err && err.message ? err.message : "Internal error",
      });
    }
  });
});

// ========== Maintenance: status update ==========
exports.sendMaintenanceStatusNotification = onDocumentUpdated(
  { document: "maintenance/{maintId}", database: "mymor-australia" },
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const { maintId } = event.params;

    const beforeStatus = (before.status || "").trim();
    const afterStatus = (after.status || "").trim();

    if (!afterStatus || beforeStatus === afterStatus) {
      console.log("No status change for maintenance", maintId);
      return null;
    }

    const requesterUid = after.uid || before.uid;
    const hostelid = after.hostelid || before.hostelid;
    if (!requesterUid) {
      console.log("No requester uid for maintenance", maintId);
      return null;
    }

    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) {
      console.log("No FCM tokens found for requester", requesterUid);
      return null;
    }

    const issue = after.problemcategory || "Maintenance";
    const room = after.roomno || "";

    const payload = {
      notification: {
        title: "Maintenance Status Update",
        body: `Your request "${issue}" for Room ${room} is now "${afterStatus}".`,
      },
      data: {
        screen: "MaintenanceRequest",
        type: "maintenance_status",
        maintenanceId: maintId,
        status: afterStatus,
        hostelid: hostelid || "",
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload,
      });
      console.log(
        `[sendMaintenanceStatusNotification] ${response.successCount} notifications sent for ${maintId}`
      );
      return response;
    } catch (err) {
      console.error("Error sending maintenance notification:", err);
      return null;
    }
  }
);

// ========== Report Incident: status update ==========
exports.sendIncidentStatusNotification = onDocumentUpdated(
  { document: "reportincident/{incidentId}", database: "mymor-australia" },
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const { incidentId } = event.params;

    const beforeStatus = (before.status || "").trim();
    const afterStatus = (after.status || "").trim();
    if (!afterStatus || beforeStatus === afterStatus) {
      console.log("[Incident] No status change for", incidentId);
      return null;
    }

    const requesterUid = after.uid || before.uid;
    const hostelid = after.hostelid || before.hostelid;
    if (!requesterUid || !hostelid) {
      console.log("[Incident] Missing uid/hostelid for", incidentId);
      return null;
    }

    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) {
      console.log("[Incident] No tokens for user", requesterUid);
      return null;
    }

    const titleOrType =
      after.title || after.incidentType || after.category || "Incident";
    const location = after.location || after.roomno || "";

    const payload = {
      notification: {
        title: "Incident Status Update",
        body: `Your incident "${titleOrType}"${location ? ` (${location})` : ""} is now "${afterStatus}".`,
      },
      data: {
        screen: "Report",
        type: "incident_status",
        incidentId,
        status: afterStatus,
        hostelid: hostelid || "",
      },
    };

    try {
      const resp = await admin.messaging().sendEachForMulticast({ tokens, ...payload });
      console.log(
        `[sendIncidentStatusNotification] ${resp.successCount} sent for ${incidentId}`
      );
      return resp;
    } catch (err) {
      console.error("[Incident] FCM error:", err);
      return null;
    }
  }
);

// ========== Feedback: status update ==========
exports.sendFeedbackStatusNotification = onDocumentUpdated(
  { document: "feedback/{feedbackId}", database: "mymor-australia" },
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const { feedbackId } = event.params;

    const beforeStatus = (before.status || "").trim();
    const afterStatus = (after.status || "").trim();
    if (!afterStatus || beforeStatus === afterStatus) {
      console.log("[Feedback] No status change for", feedbackId);
      return null;
    }

    const requesterUid = after.uid || before.uid;
    const hostelid = after.hostelid || before.hostelid;
    if (!requesterUid || !hostelid) {
      console.log("[Feedback] Missing uid/hostelid for", feedbackId);
      return null;
    }

    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) {
      console.log("[Feedback] No tokens for user", requesterUid);
      return null;
    }

    const subjectOrType =
      after.subject || after.title || after.category || "Feedback";

    const payload = {
      notification: {
        title: "Feedback Status Update",
        body: `Your feedback "${subjectOrType}" is now "${afterStatus}".`,
      },
      data: {
        screen: "Feedback",
        type: "feedback_status",
        feedbackId,
        status: afterStatus,
        hostelid: hostelid || "",
      },
    };

    try {
      const resp = await admin.messaging().sendEachForMulticast({ tokens, ...payload });
      console.log(
        `[sendFeedbackStatusNotification] ${resp.successCount} sent for ${feedbackId}`
      );
      return resp;
    } catch (err) {
      console.error("[Feedback] FCM error:", err);
      return null;
    }
  }
);

// ========== Booking: status update ==========
exports.sendBookingStatusNotification = onDocumentUpdated(
  { document: "bookingroom/{bookingId}", database: "mymor-australia" },
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const { bookingId } = event.params;

    const prev = (before.status || "").trim();
    const next = (after.status || "").trim();

    if (!next || prev === next) {
      console.log("[Booking] No status change for", bookingId);
      return null;
    }

    const requesterUid = after.uid || before.uid;
    const hostelid = after.hostelid || before.hostelid;
    if (!requesterUid || !hostelid) {
      console.log("[Booking] Missing uid/hostelid for", bookingId);
      return null;
    }

    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) {
      console.log("[Booking] No tokens for user", requesterUid);
      return null;
    }

    const roomName = after.roomname || before.roomname || "Room";
    const datePretty = (() => {
      try {
        const s = after.startdate || before.startdate;
        const e = after.enddate || before.enddate;
        const sd = s && s.toDate ? s.toDate() : s ? new Date(s) : null;
        const ed = e && e.toDate ? e.toDate() : e ? new Date(e) : null;
        if (!sd) return "";
        const fmt = (d) =>
          d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return ed
          ? ` ${sd.toDateString()} • ${fmt(sd)}–${fmt(ed)}`
          : ` ${sd.toDateString()}`;
      } catch (err) {
        return "";
      }
    })();

    const isRejected = next.toLowerCase() === "rejected";
    const title = isRejected ? "Booking Rejected" : "Booking Status Updated";
    const body = isRejected
      ? `Your booking for ${roomName}${datePretty} was rejected.`
      : `Your booking for ${roomName}${datePretty} is now "${next}".`;

    const payload = {
      notification: { title, body },
      data: {
        screen: "BookingDetail",
        type: "booking_status",
        bookingId,
        status: next,
        hostelid: hostelid || "",
      },
    };

    try {
      const resp = await admin.messaging().sendEachForMulticast({ tokens, ...payload });
      console.log(
        `[sendBookingStatusNotification] ${resp.successCount} sent for ${bookingId} (${prev} → ${next})`
      );
      return resp;
    } catch (err) {
      console.error("[Booking] FCM error:", err);
      return null;
    }
  }
);

exports.setUsersDisabledBulk = functions.https.onCall(async (data, context) => {
  const claims = (context.auth && context.auth.token) || {};
  if (!claims || claims.admin !== true) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only admins can perform this action."
    );
  }

  const toDisable = Array.isArray(data.toDisable) ? data.toDisable : [];
  const toEnable = Array.isArray(data.toEnable) ? data.toEnable : [];

  const now = admin.firestore.FieldValue.serverTimestamp();

  // ---- 1) Auth updates (batched) ----
  for (const group of chunk(toDisable, 50)) {
    await Promise.all(
      group.map((uid) =>
        admin
          .auth()
          .updateUser(uid, { disabled: true })
          .catch((e) => {
            console.error("[Auth bulk disable] failed for", uid, e.message || String(e));
            return null;
          })
      )
    );
    await new Promise((r) => setTimeout(r, 120));
  }

  for (const group of chunk(toEnable, 50)) {
    await Promise.all(
      group.map((uid) =>
        admin
          .auth()
          .updateUser(uid, { disabled: false })
          .catch((e) => {
            console.error("[Auth bulk enable] failed for", uid, e.message || String(e));
            return null;
          })
      )
    );
    await new Promise((r) => setTimeout(r, 120));
  }

  // ---- 2) Firestore updates (batched) ----
  const writeBatches = [];

  const writeChunk = async (uids, status) => {
    const b = db.batch();
    uids.forEach((uid) => {
      const ref = db.collection("users").doc(uid);
      if (status === "disabled") {
        b.set(
          ref,
          {
            accountStatus: "disabled",
            verified: false,
            disabledReason: "Not present in verification upload",
            disabledAt: now,
          },
          { merge: true }
        );
      } else {
        b.set(
          ref,
          {
            accountStatus: "active",
            verified: true,
            verifiedAt: now,
            disabledReason: null,
            disabledAt: null,
          },
          { merge: true }
        );
      }
    });
    writeBatches.push(b.commit());
  };

  for (const group of chunk(toDisable, 400)) await writeChunk(group, "disabled");
  for (const group of chunk(toEnable, 400)) await writeChunk(group, "active");
  await Promise.all(writeBatches);

  return {
    success: true,
    disabledCount: toDisable.length,
    enabledCount: toEnable.length,
  };
});

exports.bulkSetUsersStatus = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });
      }

      const body = req.body || {};
      const toDisable = Array.isArray(body.toDisable) ? body.toDisable : [];
      const toEnable = Array.isArray(body.toEnable) ? body.toEnable : [];

      const now = admin.firestore.FieldValue.serverTimestamp();

      // 1) Auth updates
      for (const group of chunk(toDisable, 50)) {
        await Promise.all(
          group.map((uid) =>
            admin
              .auth()
              .updateUser(uid, { disabled: true })
              .catch((e) => {
                console.error(
                  "[Auth bulk disable] failed for",
                  uid,
                  e.message || String(e)
                );
                return null;
              })
          )
        );
        await new Promise((r) => setTimeout(r, 120));
      }

      for (const group of chunk(toEnable, 50)) {
        await Promise.all(
          group.map((uid) =>
            admin
              .auth()
              .updateUser(uid, { disabled: false })
              .catch((e) => {
                console.error(
                  "[Auth bulk enable] failed for",
                  uid,
                  e.message || String(e)
                );
                return null;
              })
          )
        );
        await new Promise((r) => setTimeout(r, 120));
      }

      // 2) Firestore updates
      const writeBatches = [];

      const writeChunk = async (uids, status) => {
        const b = db.batch();
        uids.forEach((uid) => {
          const ref = db.collection("users").doc(uid);
          if (status === "disabled") {
            b.set(
              ref,
              {
                accountStatus: "disabled",
                verified: false,
                disabledReason: "Not present in verification upload",
                disabledAt: now,
              },
              { merge: true }
            );
          } else {
            b.set(
              ref,
              {
                accountStatus: "active",
                verified: true,
                verifiedAt: now,
                disabledReason: null,
                disabledAt: null,
              },
              { merge: true }
            );
          }
        });
        writeBatches.push(b.commit());
      };

      for (const group of chunk(toDisable, 400)) await writeChunk(group, "disabled");
      for (const group of chunk(toEnable, 400)) await writeChunk(group, "active");
      await Promise.all(writeBatches);

      return res.status(200).json({
        success: true,
        disabledCount: toDisable.length,
        enabledCount: toEnable.length,
      });
    } catch (err) {
      console.error("bulkSetUsersStatus error:", err.message || String(err));
      return res.status(500).json({ error: err.message || "Internal error" });
    }
  });
});

// ========== Groups: join request (notify creator for Private/Hidden) ==========
exports.notifyJoinRequest = onDocumentCreated(
  {
    document: "groups/{groupId}/joinRequests/{requesterUid}",
    database: "mymor-australia",
  },
  async (event) => {
    try {
      const { groupId, requesterUid } = event.params;
      const joinReq = event.data.data() || {};

      const status = (joinReq.status || "pending").toLowerCase();
      if (status !== "pending") {
        console.log("[notifyJoinRequest] status not pending, skip:", status);
        return null;
      }

      // Load group from Firestore
      const gSnap = await db.collection("groups").doc(groupId).get();
      const group = gSnap.data() || {};
      const creatorId = group.creatorId;
      const privacy = group.groupType || "Private";
      const hostelid = group.hostelid || "";

      if (!creatorId) {
        console.log("[notifyJoinRequest] no creatorId for group", groupId);
        return null;
      }
      if (!(privacy === "Private" || privacy === "Hidden")) {
        console.log("[notifyJoinRequest] groupType not Private/Hidden:", privacy);
        return null;
      }

      // 1) Write an in-app notification for creator (Firestore)
      const notifRef = db
        .collection("users")
        .doc(creatorId)
        .collection("notifications")
        .doc();
      const payload = {
        id: notifRef.id,
        type: "group:join_request",
        groupId,
        groupTitle: group.title || "",
        privacy,
        fromUid: requesterUid,
        fromName: joinReq.name || "",
        fromPhoto: joinReq.photoURL || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false,
      };
      await notifRef.set(payload);

      // Also write to inbox
      await db
        .collection("userInboxes")
        .doc(creatorId)
        .collection("groupJoinRequests")
        .doc(groupId)
        .collection("requests")
        .doc(requesterUid)
        .set({ ...payload, requestedAt: admin.firestore.FieldValue.serverTimestamp() });

      // 2) Send FCM push to the creator
      const tokens = await tokensForUser(hostelid, creatorId);
      if (!tokens.length) {
        console.log("[notifyJoinRequest] no creator tokens found");
        return null;
      }

      const message = {
        notification: {
          title: "New join request",
          body: `${joinReq.name || "Someone"} requested to join "${group.title || "your group"}"`,
        },
        data: {
          type: "group:join_request",
          screen: "AcademicGroup",
          groupId,
          hostelid: hostelid || "",
        },
      };

      const chunkSize = 500;
      for (let i = 0; i < tokens.length; i += chunkSize) {
        await admin
          .messaging()
          .sendEachForMulticast({ tokens: tokens.slice(i, i + chunkSize), ...message });
      }
      console.log("[notifyJoinRequest] push sent to creator:", creatorId);

      return null;
    } catch (err) {
      console.error(
        "[notifyJoinRequest] error:",
        err && err.message ? err.message : String(err)
      );
      return null;
    }
  }
);

// ========== Groups: join approved (notify requester) ==========
// Uses onDocumentUpdated — watches the joinRequest doc for status changing to "approved"
exports.notifyJoinApproved = onDocumentUpdated(
  {
    document: "groups/{groupId}/joinRequests/{requesterUid}",
    database: "mymor-australia",
  },
  async (event) => {
    const { groupId, requesterUid } = event.params;
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};

    const prevStatus = (before.status || "").toLowerCase().trim();
    const newStatus = (after.status || "").toLowerCase().trim();

    // Only fire when status changes to "approved"
    if (prevStatus === newStatus || newStatus !== "approved") return null;

    // Load group
    const gSnap = await db.collection("groups").doc(groupId).get();
    const group = gSnap.data() || {};
    const hostelid = group.hostelid || "";
    const title = group.title || "Group";

    // Requester tokens
    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) return null;

    // Write in-app notification to Firestore
    const notifRef = db
      .collection("users")
      .doc(requesterUid)
      .collection("notifications")
      .doc();
    await notifRef.set({
      id: notifRef.id,
      type: "group:join_approved",
      groupId,
      groupTitle: title,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false,
    });

    const message = {
      notification: {
        title: "Request approved",
        body: `You can now chat in "${title}"`,
      },
      data: {
        type: "group:join_approved",
        screen: "GroupChat",
        groupId,
        groupTitle: title,
      },
    };

    const chunkSize = 500;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      await admin
        .messaging()
        .sendEachForMulticast({ tokens: tokens.slice(i, i + chunkSize), ...message });
    }
    return null;
  }
);

// ========== Group Invite Link Creation ==========
exports.createInvite = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });
      }

      const { uid, gid, maxUses = 50, ttlHours = 72 } = req.body || {};
      if (!uid || !gid) {
        return res.status(400).json({ error: "Missing uid or gid" });
      }

      const token = require("crypto").randomBytes(12).toString("hex");
      const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;

      await db.collection("invites").doc(token).set({
        gid,
        createdBy: uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt,
        maxUses,
        uses: 0,
        active: true,
      });

      const shareUrl = `https://links.mymor.app/invite?g=${gid}&t=${token}`;

      console.log(`[createInvite] ✅ Created invite for group ${gid}: ${shareUrl}`);

      return res.status(200).json({
        success: true,
        token,
        gid,
        shareUrl,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (err) {
      console.error("[createInvite] Error:", err);
      return res.status(500).json({ error: err.message || "Internal Server Error" });
    }
  });
});

exports.acceptInvite = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });
      }

      const { uid, gid, tokenId } = req.body || {};
      if (!uid || !gid || !tokenId) {
        return res.status(400).json({ error: "Missing uid, gid, or tokenId" });
      }

      const inviteRef = db.collection("invites").doc(tokenId);
      const snap = await inviteRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Invite not found" });
      }

      const invite = snap.data() || {};
      const now = Date.now();

      if (!invite.active)
        return res.status(400).json({ error: "Invite is inactive" });
      if (invite.expiresAt && invite.expiresAt < now)
        return res.status(400).json({ error: "Invite expired" });
      if (invite.gid !== gid)
        return res.status(400).json({ error: "Invite does not match this group" });
      if (invite.maxUses && invite.uses >= invite.maxUses)
        return res.status(400).json({ error: "Invite max uses reached" });

      // Write member to Firestore (discovergroup/{gid}/members/{uid})
      const memberRef = db
        .collection("discovergroup")
        .doc(gid)
        .collection("members")
        .doc(uid);
      const existing = await memberRef.get();
      if (!existing.exists) {
        await memberRef.set({
          uid,
          isAdmin: false,
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      await inviteRef.update({
        uses: admin.firestore.FieldValue.increment(1),
      });

      return res.status(200).json({
        success: true,
        gid,
        tokenId,
        joined: true,
      });
    } catch (err) {
      console.error("[acceptInvite] Error:", err);
      return res.status(500).json({ error: err.message || "Internal Server Error" });
    }
  });
});

// ========== Notification Settings helpers ==========
// (isNotificationsEnabledFor defined above near getUserNotificationSettings)

// ========== Discover: NEW ANNOUNCEMENT ==========
exports.sendDiscoverAnnouncementNotificationV2 = onDocumentCreated(
  { document: "discoverannouncements/{announcementId}", database: "mymor-australia" },
  async (event) => {
    const { announcementId } = event.params;
    const data = event.data.data() || {};

    const groupId = data.groupid;
    const createdBy = data.createdBy || {};
    const senderUid = createdBy.uid || data.uid || "";
    const senderName = createdBy.displayName || data.user || "Someone";
    const title = data.title || "New announcement";
    const shortdesc = data.shortdesc || "";
    const bodyText = shortdesc || title;

    if (!groupId) {
      console.log("[sendDiscoverAnnouncementNotificationV2] missing groupid");
      return null;
    }

    const tokens = await tokensForDiscoverGroupMembersWithSettings(
      groupId,
      senderUid
    );
    if (!tokens.length) {
      console.log(
        "[sendDiscoverAnnouncementNotificationV2] No tokens (maybe muted/off)"
      );
      return null;
    }

    const payload = {
      notification: {
        title: "New Announcement",
        body: `${senderName}: ${bodyText}`,
      },
      data: {
        screen: "DiscoverAnnouncementDetail",
        type: "discover_announcement",
        announcementId,
        groupId,
        title,
      },
    };

    const chunkSize = 500;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      await admin.messaging().sendEachForMulticast({
        tokens: tokens.slice(i, i + chunkSize),
        ...payload,
      });
    }

    console.log(
      `[sendDiscoverAnnouncementNotificationV2] group=${groupId}, announcement=${announcementId}, tokens=${tokens.length}`
    );
    return null;
  }
);

// ========== Discover Group CHAT: message notification ==========
exports.sendDiscoverGroupMessageNotificationV2 = onDocumentCreated(
  {
    document: "discovergroup/{groupId}/messages/{messageId}",
    database: "mymor-australia",
  },
  async (event) => {
    const { groupId, messageId } = event.params;
    const msg = event.data.data() || {};

    const senderId = msg.senderId || msg.uid || "";
    const senderName = msg.sender || msg.user || "Someone";
    const messageText = msg.text || "";
    const type = msg.type || "";
    const posterUrl = msg.posterUrl || msg.imageUrl || "";

    // group name: prefer message field, fallback to discovergroup doc
    let groupName = msg.groupName || "";
    if (!groupName) {
      try {
        const gSnap = await db.collection("discovergroup").doc(groupId).get();
        const gVal = gSnap.data() || {};
        groupName = gVal.title || gVal.name || "";
      } catch (e) {
        console.log(
          "[sendDiscoverGroupMessageNotificationV2] group load error:",
          e.message || String(e)
        );
      }
    }

    if (!groupId || !senderId) {
      console.log(
        "[sendDiscoverGroupMessageNotificationV2] missing groupId/senderId, skip"
      );
      return null;
    }

    const tokens = await tokensForDiscoverGroupChatMembers(groupId, senderId);
    if (!tokens.length) {
      console.log(
        "[sendDiscoverGroupMessageNotificationV2] No tokens (maybe muted/off for all)"
      );
      return null;
    }

    const body =
      !type || type === "text"
        ? `${senderName}: ${messageText || "Sent a message"}`
        : `${senderName} ${{
            image: "sent an image",
            audio: "sent a voice message",
            video: "sent a video",
            event: "created an event",
            poll: "created a poll",
          }[type] || "sent a message"}`;

    const payload = {
      notification: {
        title: groupName || "New message",
        body,
      },
      data: {
        screen: "DiscoverGroupChat",
        type: "discover_group_message",
        groupId,
        groupName: groupName || "",
        messageId,
        senderId: senderId || "",
        senderName,
        messageType: type,
        messageText,
        posterUrl,
      },
    };

    const chunkSize = 500;
    let success = 0;
    let failure = 0;

    for (let i = 0; i < tokens.length; i += chunkSize) {
      const resp = await admin.messaging().sendEachForMulticast({
        tokens: tokens.slice(i, i + chunkSize),
        ...payload,
      });
      success += resp.successCount;
      failure += resp.failureCount;
    }

    console.log(
      `[sendDiscoverGroupMessageNotificationV2] group=${groupId}, message=${messageId}, tokens=${tokens.length}, success=${success}, failure=${failure}`
    );
    return null;
  }
);

// ========== Update user email by UID ==========
exports.updateUserEmailByUid = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });
      }

      const { uid, newEmail } = req.body || {};

      if (!uid || typeof uid !== "string") {
        return res
          .status(400)
          .json({ error: "Request body must contain { uid: <string> }" });
      }

      if (!newEmail || typeof newEmail !== "string" || !validateEmail(newEmail)) {
        return res
          .status(400)
          .json({ error: "Request body must contain a valid { newEmail: <string> }" });
      }

      const trimmedEmail = newEmail.trim().toLowerCase();

      const userRecord = await admin.auth().getUser(uid);
      const updatedUser = await admin.auth().updateUser(uid, {
        email: trimmedEmail,
      });

      return res.status(200).json({
        success: true,
        uid: updatedUser.uid,
        oldEmail: userRecord.email || null,
        newEmail: updatedUser.email,
      });
    } catch (err) {
      console.error("updateUserEmailByUid error:", err);

      if (err.code === "auth/user-not-found") {
        return res.status(404).json({ error: "User not found" });
      }
      if (err.code === "auth/email-already-exists") {
        return res
          .status(400)
          .json({ error: "This email is already in use by another account" });
      }

      return res.status(500).json({ error: err.message || "Internal error" });
    }
  });
});

// ========== UNICLUB: Join Approved / Rejected ==========
// Uses onDocumentUpdated — watches joinRequest doc for status changing to approved/rejected
exports.notifyUniclubJoinDecision = onDocumentUpdated(
  {
    document: "uniclubs/{clubId}/joinRequests/{requesterUid}",
    database: "mymor-australia",
  },
  async (event) => {
    try {
      const { clubId, requesterUid } = event.params;
      const before = event.data.before.data() || {};
      const after = event.data.after.data() || {};

      const prevStatus = (before.status || "").toLowerCase().trim();
      const newStatus = (after.status || "").toLowerCase().trim();

      // Only fire when status changes to approved or rejected
      if (
        prevStatus === newStatus ||
        (newStatus !== "approved" && newStatus !== "rejected")
      ) {
        console.log("[notifyUniclubJoinDecision] no qualifying status change:", newStatus);
        return null;
      }

      // 1) Load club info
      const cSnap = await db.collection("uniclubs").doc(clubId).get();
      const club = cSnap.data() || {};
      const clubTitle = club.title || club.name || "Club";
      const hostelid = club.hostelid || "";

      // 2) Tokens for requester
      const tokens = await tokensForUserId(requesterUid);

      // 3) Write in-app notification to Firestore
      const notifRef = db
        .collection("users")
        .doc(requesterUid)
        .collection("notifications")
        .doc();
      await notifRef.set({
        id: notifRef.id,
        type:
          newStatus === "approved"
            ? "uniclub:join_approved"
            : "uniclub:join_rejected",
        clubId,
        clubTitle,
        status: newStatus,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false,
      });

      // 4) Send push notification
      if (!tokens.length) {
        console.log("[notifyUniclubJoinDecision] no tokens for requester:", requesterUid);
        return null;
      }

      const message = {
        notification: {
          title: newStatus === "approved" ? "Request approved ✅" : "Request rejected ❌",
          body:
            newStatus === "approved"
              ? `You are now a member of "${clubTitle}".`
              : `Your request to join "${clubTitle}" was rejected.`,
        },
        data: {
          type:
            newStatus === "approved"
              ? "uniclub:join_approved"
              : "uniclub:join_rejected",
          screen: "UniclubDetail",
          clubId,
          clubTitle,
          status: newStatus,
          hostelid: String(hostelid || ""),
        },
      };

      const chunkSize = 500;
      for (let i = 0; i < tokens.length; i += chunkSize) {
        await admin
          .messaging()
          .sendEachForMulticast({ tokens: tokens.slice(i, i + chunkSize), ...message });
      }

      console.log(
        `[notifyUniclubJoinDecision] sent: club=${clubId} user=${requesterUid} status=${newStatus}`
      );
      return null;
    } catch (err) {
      console.error(
        "[notifyUniclubJoinDecision] error:",
        err.message || String(err)
      );
      return null;
    }
  }
);

// ========== Password Reset: Send OTP ==========
exports.sendPasswordResetOtp = onRequest(
  {
    region: "us-central1",
    secrets: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, OTP_SECRET],
  },
  (req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method === "OPTIONS") return res.status(204).send("");
        if (req.method !== "POST") {
          return res.status(405).json({ error: { message: "Method Not Allowed" } });
        }

        const email = String(req.body.email || "").toLowerCase().trim();
        if (!validateEmail(email)) {
          return res.status(400).json({ error: { message: "Invalid email address" } });
        }

        try {
          await admin.auth().getUserByEmail(email);
        } catch (e) {
          console.log("[sendPasswordResetOtp] email not found in Auth (silent):", email);
          return res.status(200).json({ success: true, requestId: "noop" });
        }

        const code = String(Math.floor(100000 + Math.random() * 900000));
        const requestId = crypto.randomUUID();
        const otpSecret = OTP_SECRET.value();
        if (!otpSecret) throw new Error("OTP_SECRET not configured");

        const codeHash = otpHash(email, code, otpSecret);
        const expiresAt = Date.now() + 20 * 60 * 1000; // 20 minutes

        await db.collection("passwordResetOtps").doc(requestId).set({
          email,
          codeHash,
          expiresAt,
          attempts: 0,
          used: false,
          verified: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const transporter = getSmtpTransporter();
        await withTimeout(transporter.verify(), 8000, "SMTP verify timeout");
        await withTimeout(
          transporter.sendMail({
            from: `MyMor <${SMTP_USER.value()}>`,
            to: email,
            subject: "Reset your MyMor password",
            text: [
              `Your MyMor password reset code is: ${code}`,
              "",
              "This code expires in 20 minutes.",
              "If you did not request a password reset, please ignore this email.",
            ].join("\n"),
          }),
          15000,
          "SMTP send timeout"
        );

        console.log("[sendPasswordResetOtp] OTP sent to:", email);
        return res.status(200).json({ success: true, requestId });
      } catch (err) {
        console.error("[sendPasswordResetOtp] error:", err);
        return res
          .status(500)
          .json({ error: { message: err.message || "Failed to send reset code" } });
      }
    });
  }
);

// ========== Password Reset: Verify OTP (step 2) ==========
exports.verifyPasswordResetOtp = onRequest(
  { region: "us-central1", secrets: [OTP_SECRET] },
  (req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method === "OPTIONS") return res.status(204).send("");
        if (req.method !== "POST") {
          return res.status(405).json({ error: { message: "Method Not Allowed" } });
        }

        const email = String(req.body.email || "").toLowerCase().trim();
        const code = String(req.body.code || "").trim();
        const requestId = String(req.body.requestId || "").trim();

        if (!validateEmail(email) || code.length !== 6 || !requestId) {
          return res.status(400).json({ error: { message: "Invalid payload" } });
        }

        const otpSecret = OTP_SECRET.value();
        if (!otpSecret) throw new Error("OTP_SECRET not configured");

        const ref = db.collection("passwordResetOtps").doc(requestId);
        const snap = await ref.get();

        if (!snap.exists) {
          return res.status(400).json({ error: { message: "Invalid request ID" } });
        }

        const data = snap.data() || {};

        if (data.used)
          return res.status(400).json({ error: { message: "Code already used" } });
        if (data.email !== email)
          return res.status(400).json({ error: { message: "Email mismatch" } });
        if (Date.now() > Number(data.expiresAt || 0)) {
          return res.status(400).json({ error: { message: "Code expired" } });
        }

        const attempts = Number(data.attempts || 0);
        if (attempts >= 5) {
          return res
            .status(429)
            .json({ error: { message: "Too many attempts. Request a new code." } });
        }

        const ok = otpHash(email, code, otpSecret) === data.codeHash;
        if (!ok) {
          await ref.update({ attempts: admin.firestore.FieldValue.increment(1) });
          return res
            .status(400)
            .json({ error: { message: "Incorrect code. Please try again." } });
        }

        await ref.update({ verified: true });

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("[verifyPasswordResetOtp] error:", err);
        return res
          .status(500)
          .json({ error: { message: err.message || "Verification failed" } });
      }
    });
  }
);

// ========== Password Reset: Set new password (step 3) ==========
exports.verifyOtpAndResetPassword = onRequest(
  { region: "us-central1", secrets: [OTP_SECRET] },
  (req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method === "OPTIONS") return res.status(204).send("");
        if (req.method !== "POST") {
          return res.status(405).json({ error: { message: "Method Not Allowed" } });
        }

        const email = String(req.body.email || "").toLowerCase().trim();
        const code = String(req.body.code || "").trim();
        const requestId = String(req.body.requestId || "").trim();
        const newPassword = String(req.body.newPassword || "");

        if (!validateEmail(email) || code.length !== 6 || !requestId) {
          return res.status(400).json({ error: { message: "Invalid payload" } });
        }
        if (!newPassword || newPassword.length < 8) {
          return res
            .status(400)
            .json({ error: { message: "Password must be at least 8 characters" } });
        }

        const otpSecret = OTP_SECRET.value();
        if (!otpSecret) throw new Error("OTP_SECRET not configured");

        const ref = db.collection("passwordResetOtps").doc(requestId);
        const snap = await ref.get();

        if (!snap.exists) {
          return res.status(400).json({ error: { message: "Invalid request ID" } });
        }

        const data = snap.data() || {};

        if (data.used) {
          return res
            .status(400)
            .json({ error: { message: "This reset code has already been used" } });
        }
        if (data.email !== email) {
          return res.status(400).json({ error: { message: "Email mismatch" } });
        }
        if (Date.now() > Number(data.expiresAt || 0)) {
          return res
            .status(400)
            .json({ error: { message: "Code expired. Please request a new one." } });
        }

        const alreadyVerified = data.verified === true;
        if (!alreadyVerified) {
          const attempts = Number(data.attempts || 0);
          if (attempts >= 5) {
            return res
              .status(429)
              .json({ error: { message: "Too many attempts. Request a new code." } });
          }
          const ok = otpHash(email, code, otpSecret) === data.codeHash;
          if (!ok) {
            await ref.update({ attempts: admin.firestore.FieldValue.increment(1) });
            return res.status(400).json({ error: { message: "Incorrect code" } });
          }
        }

        let userRecord;
        try {
          userRecord = await admin.auth().getUserByEmail(email);
        } catch (e) {
          return res
            .status(404)
            .json({ error: { message: "No account found with this email" } });
        }

        await admin.auth().updateUser(userRecord.uid, { password: newPassword });

        await ref.update({
          used: true,
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(
          "[verifyOtpAndResetPassword] password reset for uid:",
          userRecord.uid
        );
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("[verifyOtpAndResetPassword] error:", err);
        return res
          .status(500)
          .json({ error: { message: err.message || "Password reset failed" } });
      }
    });
  }
);

// ========== Mentions notification ==========
exports.notifyMentionedUsers = onDocumentCreated(
  { document: "social/{groupId}/posts/{postId}", database: "mymor-australia" },
  async (event) => {
    const post = event.data.data() || {};
    const { groupId, postId } = event.params;

    const senderId = post.senderId || "";
    const senderName = post.sender || "Someone";

    const mentionUids = Array.isArray(post.mentionUids) ? post.mentionUids : [];
    if (!mentionUids.length) return null;

    // prevent notifying self
    const targets = mentionUids.filter((u) => u && u !== senderId);
    if (!targets.length) return null;

    const now = admin.firestore.FieldValue.serverTimestamp();

    // Write in-app notifications + mark mentionNotified (all in one batch)
    const batch = db.batch();

    for (const targetUid of targets) {
      // skip if already notified (idempotency)
      if (post.mentionNotified && post.mentionNotified[targetUid]) continue;

      const notifRef = db
        .collection("users")
        .doc(targetUid)
        .collection("notifications")
        .doc();
      batch.set(notifRef, {
        id: notifRef.id,
        type: "mention",
        title: "You were mentioned",
        body: `${senderName} mentioned you in a post`,
        createdAt: now,
        read: false,
        data: {
          groupId,
          postId,
          senderId,
          path: post.path || "",
        },
      });
    }

    // Mark mentionNotified on the post document
    const postRef = db
      .collection("social")
      .doc(groupId)
      .collection("posts")
      .doc(postId);
    const mentionUpdate = {};
    targets.forEach((uid) => {
      mentionUpdate[`mentionNotified.${uid}`] = true;
    });
    batch.update(postRef, mentionUpdate);

    await batch.commit();

    // Send FCM push notifications
    try {
      let allTokens = [];
      for (const targetUid of targets) {
        const t = await tokensForUserId(targetUid);
        allTokens = allTokens.concat(t);
      }

      const uniqueTokens = Array.from(new Set(allTokens)).filter(Boolean);

      if (uniqueTokens.length) {
        await admin.messaging().sendEachForMulticast({
          tokens: uniqueTokens,
          notification: {
            title: "You were mentioned",
            body: `${senderName} mentioned you in a post`,
          },
          data: {
            type: "mention",
            screen: "Community",
            groupId: String(groupId),
            postId: String(postId),
            senderId: String(senderId || ""),
          },
        });
      }
    } catch (e) {
      console.log("[notifyMentionedUsers] FCM error:", e.message || String(e));
    }

    return null;
  }
);

// ============================================================
// RESTAURANT GROUP (MyMor staff module) — auto-assignment + recurrence
// Data root: restaurantGroups/{groupId} in the mymor-australia database.
// ============================================================

const RG_FIELD = admin.firestore.FieldValue;

function rgStepsItemCount(steps) {
  return (steps || []).reduce((a, s) => a + ((s.items || []).length), 0);
}

// Frozen snapshots — MUST match the web app's snapshotForAssign / snapshotForChecklist shapes.
function rgSnapshotForAssign(m) {
  const total = rgStepsItemCount(m.steps);
  return { sections: m.steps || [], checks: Array(total).fill(false), itemsTotal: total, link: m.link || "" };
}
function rgSnapshotForChecklist(c) {
  const items = c.items || [];
  return { items, checks: Array(items.length).fill(false), itemsTotal: items.length, station: c.station || "", area: c.area || "All" };
}

async function rgNotify(groupId, payload) {
  try {
    await db.collection("restaurantGroups").doc(groupId).collection("notifications").add({
      to: payload.to || "all", // staffId | "managers" | "all"
      type: payload.type || "info",
      title: payload.title || "",
      body: payload.body || "",
      venueId: payload.venueId || "",
      by: payload.by || "System",
      readBy: [],
      at: RG_FIELD.serverTimestamp(),
    });
  } catch (e) {
    console.error("[rgNotify]", e.message || String(e));
  }
}

// When a shift is created: auto-assign role-linked checklists (per shift) and
// training modules (once per person), then notify the staff member.
exports.rgOnShiftCreated = onDocumentCreated(
  {
    document: "restaurantGroups/{groupId}/venues/{venueId}/shifts/{shiftId}",
    database: "mymor-australia",
    region: "us-central1",
  },
  async (event) => {
    const shift = event.data && event.data.data();
    if (!shift || !shift.staffId) return null;
    const { groupId, venueId, shiftId } = event.params;
    const venueRef = db.collection("restaurantGroups").doc(groupId).collection("venues").doc(venueId);

    // shift-created notification (idempotent enough — trigger fires once per doc)
    await rgNotify(groupId, {
      to: shift.staffId,
      type: "shift",
      title: "New shift",
      body: `${shift.day != null ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][shift.day] + " " : ""}${shift.start || ""}–${shift.end || ""} at ${shift.venue || "your venue"}${shift.role ? " · " + shift.role : ""}`,
      venueId,
      by: "Roster",
    });

    try {
      // 1) checklists auto-linked to this role (and optionally this start time)
      const clSnap = await venueRef.collection("checklists").get();
      for (const d of clSnap.docs) {
        const c = d.data();
        // slot-linked checklists are assigned client-side by the shift-slot mechanism
        // (checklistShiftUtils.js) — skip role-matching so a shift never double-assigns.
        if (Array.isArray(c.shiftLinks) && c.shiftLinks.length) continue;
        const auto = c.autoAssign || {};
        const roles = auto.roles || [];
        if (!roles.length || !roles.includes(shift.role)) continue;
        if (auto.shiftStart && auto.shiftStart !== shift.start) continue;
        if ((c.frequency || "daily") !== "daily") continue; // weekly/monthly handled by the scheduler
        // respect the checklist's "Runs on" weekdays — don't assign an opening list on a day it doesn't run
        const shiftWeekday = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][shift.day];
        if (Array.isArray(c.days) && c.days.length && shiftWeekday && !c.days.includes(shiftWeekday)) continue;
        const aId = `auto-${d.id}-${shiftId}`; // deterministic → idempotent per shift
        const aRef = venueRef.collection("checklistAssignments").doc(aId);
        if ((await aRef.get()).exists) continue;
        await aRef.set({
          staffId: shift.staffId,
          staffName: shift.staffName || "",
          venueId,
          venue: shift.venue || "",
          checklistId: d.id,
          checklistTitle: c.title || "",
          ...rgSnapshotForChecklist(c),
          status: "Not started",
          progress: 0,
          auto: true,
          shiftId,
          createdAt: RG_FIELD.serverTimestamp(),
        });
        await rgNotify(groupId, {
          to: shift.staffId,
          type: "checklist",
          title: "Checklist for your shift",
          body: `"${c.title}" was assigned for your ${shift.start || ""} shift`,
          venueId,
          by: "Auto-assign",
        });
      }

      // 2) training modules auto-linked to this role (assigned once per person)
      const tmSnap = await venueRef.collection("trainingModules").get();
      for (const d of tmSnap.docs) {
        const m = d.data();
        const roles = (m.autoAssign && m.autoAssign.roles) || [];
        if (!roles.length || !roles.includes(shift.role)) continue;
        const aId = `auto-${d.id}-${shift.staffId}`; // once per staff member
        const aRef = venueRef.collection("trainingAssignments").doc(aId);
        if ((await aRef.get()).exists) continue;
        await aRef.set({
          staffId: shift.staffId,
          staffName: shift.staffName || "",
          venue: m.venue || shift.venue || "",
          venueId,
          moduleId: d.id,
          moduleTitle: m.title || "",
          due: "",
          priority: "normal",
          notes: "",
          ...rgSnapshotForAssign(m),
          status: "Not started",
          progress: 0,
          auto: true,
          createdAt: RG_FIELD.serverTimestamp(),
        });
        await rgNotify(groupId, {
          to: shift.staffId,
          type: "training",
          title: "Training assigned",
          body: `"${m.title}" was assigned to you (rostered as ${shift.role})`,
          venueId,
          by: "Auto-assign",
        });
      }
    } catch (e) {
      console.error("[rgOnShiftCreated]", e.message || String(e));
    }
    return null;
  }
);

// Daily 03:00 Sydney: materialize weekly/monthly recurring checklists for staff
// whose role matches, with deterministic ids so re-runs never duplicate.
exports.rgRecurringChecklists = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Australia/Sydney", region: "us-central1" },
  async () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Australia/Sydney" }));
    const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()];
    const dayOfMonth = now.getDate();

    const groups = await db.collection("restaurantGroups").get();
    for (const g of groups.docs) {
      try {
        const staffSnap = await g.ref.collection("staff").get();
        const staff = staffSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const venues = await g.ref.collection("venues").get();
        for (const v of venues.docs) {
          const clSnap = await v.ref.collection("checklists").get();
          for (const d of clSnap.docs) {
            const c = d.data();
            // slot-linked checklists are owned by the shift-slot mechanism — never scheduler-assigned
            if (Array.isArray(c.shiftLinks) && c.shiftLinks.length) continue;
            const freq = c.frequency || "daily";
            if (freq === "daily") continue;
            const due =
              (freq === "weekly" && (c.scheduleDay || "mon") === weekday) ||
              (freq === "monthly" && Number(c.scheduleDate || 1) === dayOfMonth);
            if (!due) continue;
            const roles = (c.autoAssign && c.autoAssign.roles) || [];
            const targets = staff.filter(
              (s) =>
                (s.status || "Active") === "Active" &&
                (Array.isArray(s.venueIds) ? s.venueIds.includes(v.id) : s.venueId === v.id) &&
                (roles.length ? roles.includes(s.role) : /manager|supervisor|in charge/i.test(s.role || ""))
            );
            for (const s of targets) {
              const aId = `rec-${d.id}-${s.id}-${dateKey}`;
              const aRef = v.ref.collection("checklistAssignments").doc(aId);
              if ((await aRef.get()).exists) continue;
              await aRef.set({
                staffId: s.id,
                staffName: s.displayName || s.name || [s.first, s.last].filter(Boolean).join(" ") || "",
                venueId: v.id,
                venue: c.venue || "",
                checklistId: d.id,
                checklistTitle: c.title || "",
                ...rgSnapshotForChecklist(c),
                status: "Not started",
                progress: 0,
                auto: true,
                recurring: freq,
                due: dateKey,
                createdAt: RG_FIELD.serverTimestamp(),
              });
              await rgNotify(g.id, {
                to: s.id,
                type: "checklist",
                title: freq === "weekly" ? "Weekly checklist due" : "Monthly checklist due",
                body: `"${c.title}" is due today`,
                venueId: v.id,
                by: "Scheduler",
              });
            }
            if (targets.length) {
              await rgNotify(g.id, {
                to: "managers",
                type: "checklist",
                title: `Recurring checklist scheduled`,
                body: `"${c.title}" (${freq}) was assigned to ${targets.length} staff today`,
                venueId: v.id,
                by: "Scheduler",
              });
            }
          }
        }
      } catch (e) {
        console.error("[rgRecurringChecklists]", g.id, e.message || String(e));
      }
    }
    return null;
  }
);


// ════════════════════════════════════════════════════════════════════
// Stock module — rgSellOrder (module #2 centerpiece)
// One POS sale: deduct every recipe ingredient from the venue's stock
// inside a single TRANSACTION, write movement records, and raise draft
// purchase orders when an item crosses its reorder point. POS (#3) must
// call THIS function — never reimplement the deduction client-side.
// ════════════════════════════════════════════════════════════════════

// Canonical status rule — keep in sync with
// MyMorAdmin/src/pages/restaurantgroup/rgStockUtils.js (computeStockStatus).
function rgStockStatus(qty, reorderPoint, par) {
  const q = Number(qty) || 0;
  if (q <= 0) return "critical";
  if (q <= (Number(reorderPoint) || 0)) return "critical";
  if (q <= (Number(par) || 0) * 0.5) return "low";
  return "ok";
}
const rgRound4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

exports.rgSellOrder = onCall({ region: "us-central1" }, async (request) => {
  const { groupId, venueId, lines, reference } = request.data || {};
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (!groupId || !venueId || !Array.isArray(lines) || !lines.length) {
    throw new HttpsError("invalid-argument", "groupId, venueId and lines[] are required.");
  }
  if (lines.length > 50) throw new HttpsError("invalid-argument", "Too many lines (max 50).");
  for (const l of lines) {
    const q = Number(l && l.qty == null ? 1 : l && l.qty);
    if (!l || !l.menuItemId || isNaN(q) || q <= 0 || q > 1000) {
      throw new HttpsError("invalid-argument", "Each line needs a menuItemId and a qty between 0 and 1000.");
    }
  }

  // authorisation: caller must belong to this group and hold stock view+.
  // Missing permission key fails CLOSED (none), never open.
  const empSnap = await db.collection("employees").doc(request.auth.uid).get();
  const emp = empSnap.exists ? empSnap.data() : null;
  if (!emp || String(emp.groupId || emp.groupid || "") !== String(groupId)) {
    throw new HttpsError("permission-denied", "Not a member of this group.");
  }
  const groupRole = emp.groupRole || "staff";
  const roleDefaults = {
    owner: "edit", storeAdmin: "edit", manager: "edit", staff: "none",
  };
  const hasExplicit = emp.permissions && !Array.isArray(emp.permissions) && Object.prototype.hasOwnProperty.call(emp.permissions, "stock");
  // an explicit but malformed value (false, 0, {}) fails CLOSED, not back to the role default
  const stockPerm = hasExplicit
    ? (typeof emp.permissions.stock === "string" ? emp.permissions.stock : "none")
    : (roleDefaults[groupRole] || "none");
  if (stockPerm !== "view" && stockPerm !== "edit") {
    throw new HttpsError("permission-denied", "No stock access.");
  }
  // Phase 0 / Fix 0.2 — per-venue authorisation. Owners/storeAdmins span every
  // venue in their group; managers/staff may only act on their assigned venue(s).
  // (An explicit "all" in venueIds/venueId also spans all venues.)
  const isAdminTier = groupRole === "owner" || groupRole === "storeAdmin";
  const empVenues = Array.isArray(emp.venueIds) ? emp.venueIds : (emp.venueId ? [emp.venueId] : []);
  if (!isAdminTier && !empVenues.includes("all") && !empVenues.includes(String(venueId))) {
    throw new HttpsError("permission-denied", "Not authorized for this venue.");
  }
  const actorName = emp.name || emp.email || "POS";

  const groupRef = db.collection("restaurantGroups").doc(String(groupId));
  const venueRef = groupRef.collection("venues").doc(String(venueId));
  const ref = String(reference || `SIM-${Date.now().toString().slice(-6)}`).slice(0, 60);

  // ── definitions (stable reference data — read outside the transaction) ──
  const menuIds = [...new Set(lines.map((l) => String(l.menuItemId)))];
  const menuSnaps = await db.getAll(...menuIds.map((id) => groupRef.collection("menuItems").doc(id)));
  const menuById = {};
  menuSnaps.forEach((s) => { if (s.exists) menuById[s.id] = s.data(); });

  const recipeIds = [...new Set(Object.values(menuById).map((m) => m.recipeId).filter(Boolean))];
  const recipeSnaps = recipeIds.length ? await db.getAll(...recipeIds.map((id) => groupRef.collection("recipes").doc(id))) : [];
  const recipeById = {};
  recipeSnaps.forEach((s) => { if (s.exists) recipeById[s.id] = s.data(); });

  // expand lines → per-movement deductions (provenance per menu item) and
  // the set of stock docs we must read.
  const skipped = [];
  const moves = []; // {itemId, deduct, menuItemId}
  for (const l of lines) {
    const mid = String(l.menuItemId);
    const m = menuById[mid];
    const lineQty = Number(l.qty == null ? 1 : l.qty);
    if (!m) { skipped.push({ menuItemId: mid, reason: "Menu item not found" }); continue; }
    // Phase 0 / Fix 0.1 — item-in-venue validation. Don't deduct against a venue
    // where this menu item isn't sold; skip the line (never bleed, never fail the sale).
    if (!Array.isArray(m.venueIds) || !m.venueIds.includes(String(venueId))) {
      skipped.push({ menuItemId: mid, reason: "menu item not sold at this venue" });
      continue;
    }
    const r = m.recipeId ? recipeById[m.recipeId] : null;
    if (!r || !Array.isArray(r.ingredients) || !r.ingredients.length) {
      skipped.push({ menuItemId: mid, reason: `No recipe for ${m.displayName || mid} — link one in Recipe costing` });
      continue;
    }
    for (const ing of r.ingredients) {
      if (!ing || !ing.itemId) continue;
      moves.push({ itemId: String(ing.itemId), deduct: rgRound4((Number(ing.qty) || 0) * lineQty), menuItemId: mid, menuName: m.displayName || mid });
    }
  }
  if (!moves.length) return { ok: true, deducted: [], skipped, lowStock: [], draftsCreated: 0 };

  const itemIds = [...new Set(moves.map((mv) => mv.itemId))];
  const itemSnaps = await db.getAll(...itemIds.map((id) => groupRef.collection("inventoryItems").doc(id)));
  const itemById = {};
  itemSnaps.forEach((s) => { if (s.exists) itemById[s.id] = s.data(); });

  // ── the transaction: read stock + draft-PO state, then write everything ──
  const result = await db.runTransaction(async (tx) => {
    const stockRefs = itemIds.map((id) => venueRef.collection("stock").doc(id));
    const stockSnaps = await tx.getAll(...stockRefs);
    const stockById = {};
    stockSnaps.forEach((s) => { stockById[s.ref.id] = { ref: s.ref, data: s.exists ? s.data() : null }; });

    // run the deduction math sequentially so before/after chain correctly
    // when two lines touch the same ingredient.
    const running = {}; // itemId -> qty
    const perItemFinal = {};
    const movements = [];
    const txSkipped = []; // tx-local: the tx body can retry on contention
    for (const mv of moves) {
      const st = stockById[mv.itemId];
      if (!st || !st.data) { txSkipped.push({ menuItemId: mv.menuItemId, reason: `No stock record for ${mv.itemId} at this venue` }); continue; }
      const before = running[mv.itemId] != null ? running[mv.itemId] : (Number(st.data.qtyOnHand) || 0);
      const after = Math.max(0, rgRound4(before - mv.deduct));
      running[mv.itemId] = after;
      const item = itemById[mv.itemId] || {};
      movements.push({
        itemId: mv.itemId, itemName: item.name || mv.itemId, type: "posSale",
        // after-before, not -deduct: when the deduction clamps at zero the
        // audit trail must still sum (before + qtyChange === after).
        qtyChange: rgRound4(after - before), before, after, unit: item.unit || "",
        reason: "", reference: ref, menuItemId: mv.menuItemId, menuName: mv.menuName,
        by: actorName, byUid: request.auth.uid,
        costAtMove: rgRound4((before - after) * (Number(item.cost) || 0)), // real cost, not the prototype's ×8 fake
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      perItemFinal[mv.itemId] = after;
    }

    // reorder triggers: read existing open drafts INSIDE the tx so two
    // concurrent sales cannot both create one (T2.2).
    const reorderItems = [];
    for (const [itemId, after] of Object.entries(perItemFinal)) {
      const st = stockById[itemId].data;
      if (after <= (Number(st.reorderPoint) || 0)) reorderItems.push(itemId);
    }
    const draftChecks = {};
    for (const itemId of reorderItems) {
      const qy = groupRef.collection("purchaseOrders")
        .where("status", "==", "draft").where("venueId", "==", String(venueId)).where("itemKey", "==", itemId);
      draftChecks[itemId] = await tx.get(qy);
    }

    // ── writes ──
    for (const [itemId, after] of Object.entries(perItemFinal)) {
      const st = stockById[itemId].data;
      tx.set(stockById[itemId].ref, {
        qtyOnHand: after,
        status: rgStockStatus(after, st.reorderPoint, st.par),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    for (const m of movements) tx.set(venueRef.collection("stockMovements").doc(), m);

    let draftsCreated = 0;
    for (const itemId of reorderItems) {
      const st = stockById[itemId].data;
      const item = itemById[itemId] || {};
      const provenance = moves.filter((mv) => mv.itemId === itemId).map((mv) => ({
        menuItemId: mv.menuItemId, soldQty: mv.deduct, reference: ref, at: new Date().toISOString(),
      }));
      const existing = draftChecks[itemId];
      if (existing && !existing.empty) {
        tx.set(existing.docs[0].ref, {
          triggeredBy: admin.firestore.FieldValue.arrayUnion(...provenance),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        continue; // one open draft per item+venue — never duplicate
      }
      const qty = Number(st.reorderQty) || Number(st.par) || 0;
      if (qty <= 0) continue; // no sensible reorder quantity configured — don't raise a $0 draft
      const unitCost = Number(item.cost) || 0;
      tx.set(groupRef.collection("purchaseOrders").doc(), {
        status: "draft", autoDraft: true, itemKey: itemId,
        supplierId: item.supplierId || null, venueId: String(venueId),
        lines: [{ itemId, itemName: item.name || itemId, qty, unitCost, unit: item.unit || "" }],
        total: rgRound4(qty * unitCost),
        triggeredBy: provenance,
        createdBy: "auto", sentAt: null, expectedAt: null, receivedAt: null,
        receivedLines: [], discrepancies: [], invoiceUrl: "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      draftsCreated++;
    }

    const deducted = Object.entries(perItemFinal).map(([itemId, after]) => {
      const st = stockById[itemId].data;
      const item = itemById[itemId] || {};
      return { itemId, name: item.name || itemId, unit: item.unit || "", after, status: rgStockStatus(after, st.reorderPoint, st.par) };
    });
    return { deducted, draftsCreated, txSkipped };
  });
  skipped.push(...result.txSkipped);

  const lowStock = result.deducted.filter((d) => d.status === "critical" || d.status === "low")
    .map((d) => `${d.name} now ${d.after}${d.unit}`);

  // low-stock heads-up for managers (after commit; never fails the sale)
  if (lowStock.length) {
    await rgNotify(String(groupId), {
      to: "managers", type: "stock", title: "Low stock after sale",
      body: lowStock.slice(0, 6).join(", "), venueId: String(venueId), by: actorName,
    }).catch(() => {});
  }

  return { ok: true, deducted: result.deducted, skipped, lowStock, draftsCreated: result.draftsCreated };
});
