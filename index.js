/* eslint-disable */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onValueCreated } = require("firebase-functions/v2/database");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { getDatabase } = require("firebase-admin/database");
const cors = require("cors")({ origin: true });
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = getDatabase();
const fsdb = admin.firestore();           
const rtdb = admin.database();  
// ========== Email ==========
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "chiggy14@gmail.com",
    pass: "xggf umkg lpwk kbqn",
  },
});

function validateEmail(email) {
  const re = /\S+@\S+\.\S+/;
  return re.test(email);
}

exports.sendVerificationCode = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { email } = req.body;
  console.log("Received email:", email);

  if (!email || !validateEmail(email)) {
    return res.status(400).json({
      error: { message: "Invalid or missing email", status: "INVALID_ARGUMENT" },
    });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await admin
    .firestore()
    .collection("emailVerifications")
    .doc(email)
    .set({
      code,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

  const msg = {
    to: email,
    from: "chiggy14@gmaill.com",
    subject: "Your Verification Code",
    text: `Your verification code is ${code}`,
  };

  try {
    await transporter.sendMail(msg);
    res.json({ success: true, message: `Verification code sent to ${email}` });
    return { success: true, message: "Code sent." };
  } catch (error) {
    console.error("Error sending email:", error);
    throw new functions.https.HttpsError("internal", "Failed to send email.");
  }
});

// ========== Helper: collect tokens by hostel ==========
async function tokensForHostel(hostelid, excludeUid = null) {
  if (!hostelid) return [];
  const snap = await db.ref(`/hostelTokens/${hostelid}`).once("value");
  if (!snap.exists()) return [];

  const tokens = [];
  snap.forEach((child) => {
    // child.key is uid; child.val() can be a string token or object with token(s)
    if (excludeUid && child.key === String(excludeUid)) return;
    const v = child.val();
    if (!v) return;

    if (typeof v === "string") {
      tokens.push(v);
    } else if (Array.isArray(v)) {
      tokens.push(...v.filter(Boolean));
    } else if (typeof v === "object") {
      if (v.token) tokens.push(v.token);
      if (Array.isArray(v.tokens)) tokens.push(...v.tokens.filter(Boolean));
      Object.values(v).forEach((maybe) => {
        if (typeof maybe === "string") tokens.push(maybe);
        if (Array.isArray(maybe)) tokens.push(...maybe.filter(Boolean));
      });
    }
  });

  // dedupe
  return Array.from(new Set(tokens.filter(Boolean)));
}
// Collect tokens for all members of a group (excluding sender), deduped
async function tokensForGroupMembers(hostelid, groupId, excludeUid = null) {
  // members live in RTDB: /groups/{groupId}/members
  const snap = await db.ref(`/groups/${groupId}/members`).once("value");
  const members = snap.val() || {};

  // member keys are user UIDs in your schema
  const memberUids = Object.keys(members).filter((uid) => uid && uid !== String(excludeUid));

  // gather tokens per member (scoped to hostel)
  const tokenSets = await Promise.all(memberUids.map((uid) => tokensForUser(hostelid, uid)));
  const all = tokenSets.flat().filter(Boolean);

  // dedupe
  return Array.from(new Set(all));
}
// ========== Group chat ==========
exports.sendGroupMessageNotification = onValueCreated(
  "/messages/{groupId}/{messageId}",
  async (event) => {
    const { groupId } = event.params;
    const messageData = event.data.val() || {};

    const groupName = messageData.groupName || "";
    const senderId  = messageData.senderId || "";
    const senderName = messageData.sender || "Someone";
    const messageText = messageData.text || "";
    const type = messageData.type || "";
    const posterUrl = messageData.posterUrl || "";

    // Resolve hostelid (prefer message, fallback to group)
    let hostelid = messageData.hostelid;
    if (!hostelid) {
      const gSnap = await db.ref(`/groups/${groupId}`).once("value");
      const gVal = gSnap.val() || {};
      hostelid = gVal.hostelid || "";
    }

    // === NEW: only notify group members (exclude sender) ===
    const tokens = await tokensForGroupMembers(hostelid, groupId, senderId);
    if (!tokens.length) {
      console.log("[sendGroupMessageNotification] No member tokens found");
      return null;
    }

    const body =
      !type || type === "text"
        ? `${senderName}: ${messageText || "Sent a message"}`
        : `${senderName} ${
            {
              image: "sent an image",
              audio: "sent a voice message",
              video: "sent a video",
              event: "created an event",
              poll:  "created a poll",
            }[type] || "sent a message"
          }`;

    // Prepare payload (keep your data keys)
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

    // FCM supports up to 500 tokens per multicast call—chunk defensively
    const chunkSize = 500;
    const chunks = [];
    for (let i = 0; i < tokens.length; i += chunkSize) {
      chunks.push(tokens.slice(i, i + chunkSize));
    }

    try {
      let success = 0, failure = 0;
      for (const chunk of chunks) {
        const resp = await admin.messaging().sendEachForMulticast({ tokens: chunk, ...base });
        success += resp.successCount;
        failure += resp.failureCount;
      }
      console.log(`[sendGroupMessageNotification] Sent to members: success=${success} failure=${failure} total=${tokens.length}`);
      return { success, failure, total: tokens.length };
    } catch (error) {
      console.error("[sendGroupMessageNotification] FCM error:", error);
      return null;
    }
  }
);
// ========== Announcements: comment ==========
exports.sendAnnouncementsCommentNotification = onValueCreated(
  "/announcements/{announcementId}/comments/{commentId}",
  async (event) => {
    const comment = event.data.val() || {};
    const { announcementId } = event.params;
    const title = comment.title;
    const senderId = comment.senderId;
    const senderName = comment.sender || "Someone";
    const messageText = comment.content || "";

    const announcementSnap = await db
      .ref(`/announcements/${announcementId}`)
      .get();
    const announcement = announcementSnap.val();

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
exports.sendAnnouncementsReplyNotification = onValueCreated(
  "/announcements/{announcementId}/comments/{commentId}/replies/{replyId}",
  async (event) => {
    const reply = event.data.val() || {};
    const { announcementId, commentId } = event.params;
    const title = reply.title;
    const senderId = reply.senderId;
    const senderName = reply.sender || "Someone";
    const messageText = reply.content || "";

    const commentSnap = await db
      .ref(`/announcements/${announcementId}/comments/${commentId}`)
      .get();
    const comment = commentSnap.val();
    if (!comment || senderId === comment.uid) return null;

    const annSnap = await db.ref(`/announcements/${announcementId}`).get();
    const announcement = annSnap.val();

    const hostelid = announcement.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens) return null;

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
exports.sendCommunitynNewPostNotification = onValueCreated(
  "/community/{postId}",
  async (event) => {
    const post = event.data.val() || {};
    const { postId } = event.params;
    const senderId = post.senderId;
    const senderName = post.sender || "Someone";
    const messageText = post.content || "";

    if (!post || !post.content || !post.senderId) return null;

    const hostelid = post.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens) return null;

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
exports.sendCommunityCommentNotification = onValueCreated(
  "/community/{postId}/comments/{commentId}",
  async (event) => {
    const comment = event.data.val() || {};
    const { postId } = event.params;
    const senderId = comment.senderId;
    const senderName = comment.sender || "Someone";
    const messageText = comment.content || "";

    const communitySnap = await db.ref(`/community/${postId}`).get();
    const post = communitySnap.val();
    if (!post || comment.senderId === post.uid) return null;

    const hostelid = post.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens) return null;

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
exports.sendCommunityReplyNotification = onValueCreated(
  "/community/{postId}/comments/{commentId}/replies/{replyId}",
  async (event) => {
    const reply = event.data.val() || {};
    const { postId, commentId } = event.params;
    const senderId = reply.senderId;
    const senderName = reply.sender || "Someone";
    const messageText = reply.content || "";

    const commentSnap = await db
      .ref(`/community/${postId}/comments/${commentId}`)
      .get();
    const comment = commentSnap.val();
    if (!comment || senderId === comment.uid) return null;

    const postSnap = await db.ref(`/community/${postId}`).get();
    const post = postSnap.val();

    const hostelid = post.hostelid;
    const tokens = await tokensForHostel(hostelid, senderId);
    if (!tokens) return null;

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

// ========== Dining menu (Firestore) ==========
exports.sendMenuUpdateNotification = onDocumentUpdated(
  "menus/{menuDate}",
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
// ========== Admin HTTP endpoints (unchanged) ==========
exports.deleteUserByUid = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res
          .status(405)
          .json({ error: "Method Not Allowed. Use POST." });
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
exports.sendAnnouncementsNewNotification = onValueCreated(
  "/announcements/{announcementId}",
  async (event) => {
    const data = event.data.val() || {};
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
        return res
          .status(405)
          .json({ error: "Method Not Allowed. Use POST." });
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
        return res
          .status(405)
          .json({ error: "Method Not Allowed. Use POST." });
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
  if (norm(claims.role) === "superadmin" || norm(claims.type) === "superadmin") return true;

  if (Array.isArray(claims.roles)) {
    for (var i = 0; i < claims.roles.length; i++) {
      if (norm(claims.roles[i]) === "superadmin") return true;
    }
  }
  if (claims.roles && typeof claims.roles === "object" && !Array.isArray(claims.roles)) {
    for (var k in claims.roles) {
      if (Object.prototype.hasOwnProperty.call(claims.roles, k)) {
        if (norm(k) === "superadmin" && !!claims.roles[k]) return true;
      }
    }
  }
  if (claims.isSuperadmin === true || claims.is_superadmin === true) return true;
  return false;
}

async function findSuperadminUIDsByClaims(uids) {
  const auth = admin.auth();
  const result = new Set();

  for (const group of chunk(uids, 50)) {
    const users = await Promise.all(
      group.map(function (uid) {
        return auth.getUser(uid).then(
          function (u) { return u; },
          function () { return null; }
        );
      })
    );
    users.forEach(function (u) {
      if (u && isSuperadminClaims(u.customClaims || {})) {
        result.add(u.uid);
      }
    });
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  return result;
}

function toUidSet(arr) {
  if (!Array.isArray(arr)) return new Set();
  return new Set(arr.map(function (x) { return String(x).trim(); }).filter(Boolean));
}

// Collect employees linked to a hostel across common schema variants
async function collectEmployeesForHostel(hostelid) {
  const col = fsdb.collection(EMP_COLLECTION);
  const hostRef = fsdb.collection("hostel").doc(hostelid);

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
      console.warn("collectEmployeesForHostel query skipped:", e && e.message ? e.message : String(e));
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
exports.disableHostelAndLockEmployees = functions.https.onRequest(function (req, res) {
  cors(req, res, async function () {
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed. Use POST." });

      const body = req.body || {};
      const hostelid = body.hostelid;
      const reason = body.reason || "Disabled by admin action";
      const excludeUids = Array.isArray(body.excludeUids) ? body.excludeUids : [];

      if (!hostelid || typeof hostelid !== "string") {
        return res.status(400).json({ error: "Request must include { hostelid: <string> }" });
      }

      const FieldValue = admin.firestore.FieldValue;
      const skipUidSet = toUidSet(excludeUids);

      // 1) Mark hostel disabled
      await fsdb.collection("hostel").doc(hostelid).set(
        {
          active: false,
          lockedAt: FieldValue.serverTimestamp(),
          lockedBy: "http",
          disabledReason: reason
        },
        { merge: true }
      );

      // 2) Collect employees
      let empDocs = await collectEmployeesForHostel(hostelid);

      // Build uid list from DOC IDs (doc.id === Auth UID)
      let uids = [];
      let skippedSuperadmins = 0;
      let skippedByUid = 0;

      empDocs = empDocs.filter(function (docSnap) {
        const d = docSnap.data() || {};
        const duid = String(docSnap.id); // <-- use doc id as UID

        if (skipUidSet.has(duid)) { skippedByUid++; return false; }
        if (isSuperadminDoc(d))   { skippedSuperadmins++; return false; }

        uids.push(duid);
        return true;
      });

      // claims-level skip
      const claimSupers = await findSuperadminUIDsByClaims(uids);
      if (claimSupers.size) {
        claimSupers.forEach(function (uid) { skipUidSet.add(uid); });
        skippedSuperadmins += claimSupers.size;

        empDocs = empDocs.filter(function (ds) {
          const duid2 = String(ds.id);
          return !skipUidSet.has(duid2);
        });
        uids = uids.filter(function (uid) { return !skipUidSet.has(uid); });
      }

      // 3) Firestore batched updates
      let fsCount = 0;
      for (const group of chunk(empDocs, 450)) {
        const batch = fsdb.batch();
        group.forEach(function (ds) {
          batch.set(
            ds.ref,
            {
              active: false,
              lockedAt: FieldValue.serverTimestamp(),
              lockedBy: "http",
              lockedNote: reason
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
              .then(function () { authCount++; })
              .catch(function (e) {
                console.error("Auth disable failed for", uid, e && e.message ? e.message : String(e));
              });
          })
        );
        await new Promise(function (r) { setTimeout(r, 150); });
      }

      console.log("[disableHostelAndLockEmployees]",
        "hostel:", hostelid, "docs:", empDocs.length, "uids:", uids.length,
        "skippedSuperadmins:", skippedSuperadmins, "skippedByUid:", skippedByUid);

      return res.status(200).json({
        success: true,
        hostelid: hostelid,
        firestoreUpdatedEmployees: fsCount,
        authDisabledUsers: authCount,
        skippedSuperadmins: skippedSuperadmins,
        skippedByUid: skippedByUid
      });
    } catch (err) {
      console.error("disableHostelAndLockEmployees error:", err && err.message ? err.message : String(err));
      return res.status(500).json({ error: err && err.message ? err.message : "Internal error" });
    }
  });
});

exports.enableHostelAndEmployees = functions.https.onRequest(function (req, res) {
  cors(req, res, async function () {
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed. Use POST." });

      const body = req.body || {};
      const hostelid = body.hostelid;
      const reason = body.reason || "Enabled by admin action";
      const excludeUids = Array.isArray(body.excludeUids) ? body.excludeUids : [];

      if (!hostelid || typeof hostelid !== "string") {
        return res.status(400).json({ error: "Request must include { hostelid: <string> }" });
      }

      const FieldValue = admin.firestore.FieldValue;
      const skipUidSet = toUidSet(excludeUids);

      // 1) Mark hostel enabled
      await fsdb.collection("hostel").doc(hostelid).set(
        {
          active: true,
          unlockedAt: FieldValue.serverTimestamp(),
          unlockedBy: "http",
          enabledReason: reason
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
        const duid = String(docSnap.id); // <-- use doc id as UID

        if (skipUidSet.has(duid)) { skippedByUid++; return false; }
        if (isSuperadminDoc(d))   { skippedSuperadmins++; return false; }

        uids.push(duid);
        return true;
      });

      const claimSupers = await findSuperadminUIDsByClaims(uids);
      if (claimSupers.size) {
        claimSupers.forEach(function (uid) { skipUidSet.add(uid); });
        skippedSuperadmins += claimSupers.size;

        empDocs = empDocs.filter(function (ds) {
          const duid2 = String(ds.id);
          return !skipUidSet.has(duid2);
        });
        uids = uids.filter(function (uid) { return !skipUidSet.has(uid); });
      }

      // 3) Firestore batched updates
      let fsCount = 0;
      for (const group of chunk(empDocs, 450)) {
        const batch = fsdb.batch();
        group.forEach(function (ds) {
          batch.set(
            ds.ref,
            {
              active: true,
              unlockedAt: FieldValue.serverTimestamp(),
              unlockedBy: "http",
              unlockedNote: reason
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
              .then(function () { authCount++; })
              .catch(function (e) {
                console.error("Auth enable failed for", uid, e && e.message ? e.message : String(e));
              });
          })
        );
        await new Promise(function (r) { setTimeout(r, 150); });
      }

      console.log("[enableHostelAndEmployees]",
        "hostel:", hostelid, "docs:", empDocs.length, "uids:", uids.length,
        "skippedSuperadmins:", skippedSuperadmins, "skippedByUid:", skippedByUid);

      return res.status(200).json({
        success: true,
        hostelid: hostelid,
        firestoreUpdatedEmployees: fsCount,
        authEnabledUsers: authCount,
        skippedSuperadmins: skippedSuperadmins,
        skippedByUid: skippedByUid
      });
    } catch (err) {
      console.error("enableHostelAndEmployees error:", err && err.message ? err.message : String(err));
      return res.status(500).json({ error: err && err.message ? err.message : "Internal error" });
    }
  });
});

// ========== Maintenance: status update ==========
exports.sendMaintenanceStatusNotification = onDocumentUpdated(
  "maintenance/{maintId}",
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const { maintId } = event.params;

    const beforeStatus = (before.status || "").trim();
    const afterStatus = (after.status || "").trim();

    // only act if status changed
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

    // Tokens: look inside hostelTokens tree at specific uid
    const snap = await db.ref(`/hostelTokens/${hostelid}/${requesterUid}`).once("value");
    const val = snap.val();
    if (!val) {
      console.log("No tokens for user", requesterUid);
      return null;
    }

    let tokens = [];
    if (typeof val === "string") tokens = [val];
    else if (Array.isArray(val)) tokens = val;
    else if (typeof val === "object") {
      if (val.token) tokens.push(val.token);
      if (Array.isArray(val.tokens)) tokens.push(...val.tokens);
      Object.values(val).forEach((maybe) => {
        if (typeof maybe === "string") tokens.push(maybe);
        if (Array.isArray(maybe)) tokens.push(...maybe);
      });
    }
    tokens = Array.from(new Set(tokens.filter(Boolean)));

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

// ========= Helper: collect tokens for a specific user in a hostel =========
async function tokensForUser(hostelid, uid) {
  if (!hostelid || !uid) return [];
  const snap = await db.ref(`/hostelTokens/${hostelid}/${uid}`).once("value");
  const val = snap.val();
  if (!val) return [];

  let tokens = [];
  if (typeof val === "string") tokens = [val];
  else if (Array.isArray(val)) tokens = val;
  else if (typeof val === "object") {
    if (val.token) tokens.push(val.token);
    if (Array.isArray(val.tokens)) tokens.push(...val.tokens);
    Object.values(val).forEach((maybe) => {
      if (typeof maybe === "string") tokens.push(maybe);
      if (Array.isArray(maybe)) tokens.push(...maybe);
    });
  }
  return Array.from(new Set(tokens.filter(Boolean)));
}
// ========== Report Incident: status update ==========
exports.sendIncidentStatusNotification = onDocumentUpdated(
  "reportincident/{incidentId}",
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const { incidentId } = event.params;

    const beforeStatus = (before.status || "").trim();
    const afterStatus  = (after.status  || "").trim();
    if (!afterStatus || beforeStatus === afterStatus) {
      console.log("[Incident] No status change for", incidentId);
      return null;
    }

    const requesterUid = after.uid || before.uid;
    const hostelid     = after.hostelid || before.hostelid;
    if (!requesterUid || !hostelid) {
      console.log("[Incident] Missing uid/hostelid for", incidentId);
      return null;
    }

    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) {
      console.log("[Incident] No tokens for user", requesterUid);
      return null;
    }

    const titleOrType = after.title || after.incidentType || after.category || "Incident";
    const location    = after.location || after.roomno || "";

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
      console.log(`[sendIncidentStatusNotification] ${resp.successCount} sent for ${incidentId}`);
      return resp;
    } catch (err) {
      console.error("[Incident] FCM error:", err);
      return null;
    }
  }
);
// ========== Feedback: status update ==========
exports.sendFeedbackStatusNotification = onDocumentUpdated(
  "feedback/{feedbackId}",
  async (event) => {
    const before = event.data.before.data() || {};
    const after  = event.data.after.data() || {};
    const { feedbackId } = event.params;

    const beforeStatus = (before.status || "").trim();
    const afterStatus  = (after.status  || "").trim();
    if (!afterStatus || beforeStatus === afterStatus) {
      console.log("[Feedback] No status change for", feedbackId);
      return null;
    }

    const requesterUid = after.uid || before.uid;
    const hostelid     = after.hostelid || before.hostelid;
    if (!requesterUid || !hostelid) {
      console.log("[Feedback] Missing uid/hostelid for", feedbackId);
      return null;
    }

    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) {
      console.log("[Feedback] No tokens for user", requesterUid);
      return null;
    }

    const subjectOrType = after.subject || after.title || after.category || "Feedback";

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
      console.log(`[sendFeedbackStatusNotification] ${resp.successCount} sent for ${feedbackId}`);
      return resp;
    } catch (err) {
      console.error("[Feedback] FCM error:", err);
      return null;
    }
  }
);


// ========== Booking: status update ==========
exports.sendBookingStatusNotification = onDocumentUpdated(
  "bookingroom/{bookingId}",
  async (event) => {
    const before = event.data.before.data() || {};
    const after  = event.data.after.data()  || {};
    const { bookingId } = event.params;

    const prev = (before.status || "").trim();
    const next = (after.status  || "").trim();

    // Only notify on a change
    if (!next || prev === next) {
      console.log("[Booking] No status change for", bookingId);
      return null;
    }

    const requesterUid = after.uid || before.uid;
    const hostelid     = after.hostelid || before.hostelid;
    if (!requesterUid || !hostelid) {
      console.log("[Booking] Missing uid/hostelid for", bookingId);
      return null;
    }

    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) {
      console.log("[Booking] No tokens for user", requesterUid);
      return null;
    }

    const roomName   = after.roomname || before.roomname || "Room";
    const datePretty = (() => {
      try {
        const s = (after.startdate || before.startdate);
        const e = (after.enddate   || before.enddate);
        const sd = s.toDate ? s.toDate() : s ? new Date(s) : null;
        const ed = e.toDate ? e.toDate() : e ? new Date(e) : null;
        if (!sd) return "";
        const fmt = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return ed
          ? ` ${sd.toDateString()} • ${fmt(sd)}–${fmt(ed)}`
          : ` ${sd.toDateString()}`;
      } catch (err) {
        return "";
      }
    })();

    // Slightly different copy if specifically rejected
    const isRejected = next.toLowerCase() === "rejected";
    const title = isRejected ? "Booking Rejected" : "Booking Status Updated";
    const body  = isRejected
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
      console.log(`[sendBookingStatusNotification] ${resp.successCount} sent for ${bookingId} (${prev} → ${next})`);
      return resp;
    } catch (err) {
      console.error("[Booking] FCM error:", err);
      return null;
    }
  }
);


exports.setUsersDisabledBulk = functions.https.onCall(async (data, context) => {
  // Optional: enforce admin
  const claims = (context.auth && context.auth.token) || {};
  if (!claims || claims.admin !== true) {
    throw new functions.https.HttpsError("permission-denied", "Only admins can perform this action.");
  }

  const toDisable = Array.isArray(data.toDisable) ? data.toDisable : [];
  const toEnable  = Array.isArray(data.toEnable)  ? data.toEnable  : [];

  const fs = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();

  // ---- 1) Auth updates (batched) ----
  for (const group of chunk(toDisable, 50)) {
    await Promise.all(
      group.map(uid =>
        admin.auth().updateUser(uid, { disabled: true }).catch(e => {
          console.error("[Auth bulk disable] failed for", uid, e.message || String(e));
          return null;
        })
      )
    );
    await new Promise(r => setTimeout(r, 120));
  }

  for (const group of chunk(toEnable, 50)) {
    await Promise.all(
      group.map(uid =>
        admin.auth().updateUser(uid, { disabled: false }).catch(e => {
          console.error("[Auth bulk enable] failed for", uid, e.message || String(e));
          return null;
        })
      )
    );
    await new Promise(r => setTimeout(r, 120));
  }

  // ---- 2) Firestore updates (batched) ----
  const writeBatches = [];

  const writeChunk = async (uids, status) => {
    const b = fs.batch();
    uids.forEach(uid => {
      const ref = fs.collection("users").doc(uid); // doc.id == uid
      if (status === "disabled") {
        b.set(ref, {
          accountStatus: "disabled",
          verified: false,
          disabledReason: "Not present in verification upload",
          disabledAt: now
        }, { merge: true });
      } else {
        b.set(ref, {
          accountStatus: "active",
          verified: true,
          verifiedAt: now,
          disabledReason: null,
          disabledAt: null
        }, { merge: true });
      }
    });
    writeBatches.push(b.commit());
  };

  for (const group of chunk(toDisable, 400)) await writeChunk(group, "disabled");
  for (const group of chunk(toEnable, 400))  await writeChunk(group, "active");
  await Promise.all(writeBatches);

  return {
    success: true,
    disabledCount: toDisable.length,
    enabledCount: toEnable.length
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
      const toEnable  = Array.isArray(body.toEnable)  ? body.toEnable  : [];

      const fs = admin.firestore();
      const now = admin.firestore.FieldValue.serverTimestamp();

      // (Optional) Add your own auth/secret check here if exposed publicly.

      // 1) Auth updates
      for (const group of chunk(toDisable, 50)) {
        await Promise.all(
          group.map(uid =>
            admin.auth().updateUser(uid, { disabled: true }).catch(e => {
              console.error("[Auth bulk disable] failed for", uid, e.message || String(e));
              return null;
            })
          )
        );
        await new Promise(r => setTimeout(r, 120));
      }

      for (const group of chunk(toEnable, 50)) {
        await Promise.all(
          group.map(uid =>
            admin.auth().updateUser(uid, { disabled: false }).catch(e => {
              console.error("[Auth bulk enable] failed for", uid, e.message || String(e));
              return null;
            })
          )
        );
        await new Promise(r => setTimeout(r, 120));
      }

      // 2) Firestore updates
      const writeBatches = [];

      const writeChunk = async (uids, status) => {
        const b = fs.batch();
        uids.forEach(uid => {
          const ref = fs.collection("users").doc(uid); // doc.id == uid
          if (status === "disabled") {
            b.set(ref, {
              accountStatus: "disabled",
              verified: false,
              disabledReason: "Not present in verification upload",
              disabledAt: now
            }, { merge: true });
          } else {
            b.set(ref, {
              accountStatus: "active",
              verified: true,
              verifiedAt: now,
              disabledReason: null,
              disabledAt: null
            }, { merge: true });
          }
        });
        writeBatches.push(b.commit());
      };

      for (const group of chunk(toDisable, 400)) await writeChunk(group, "disabled");
      for (const group of chunk(toEnable, 400))  await writeChunk(group, "active");
      await Promise.all(writeBatches);

      return res.status(200).json({
        success: true,
        disabledCount: toDisable.length,
        enabledCount: toEnable.length
      });
    } catch (err) {
      console.error("bulkSetUsersStatus error:", err.message || String(err));
      return res.status(500).json({ error: err.message || "Internal error" });
    }
  });
});

// ========== Groups: join request (notify creator for Private/Hidden) ==========
exports.notifyJoinRequest = onValueCreated(
  "/groups/{groupId}/joinRequests/{requesterUid}",
  async (event) => {
    try {
      const { groupId, requesterUid } = event.params;
      const joinReq = event.data.val() || {};

      // Only when request is created (or is pending)
      const status = (joinReq.status || "pending").toLowerCase();
      if (status !== "pending") {
        console.log("[notifyJoinRequest] status not pending, skip:", status);
        return null;
      }

      // Load group → need creatorId, groupType, title, hostelid
      const gSnap = await db.ref(`/groups/${groupId}`).once("value");
      const group = gSnap.val() || {};
      const creatorId = group.creatorId;
      const privacy   = group.groupType || "Private";
      const hostelid  = group.hostelid || "";

      if (!creatorId) {
        console.log("[notifyJoinRequest] no creatorId for group", groupId);
        return null;
      }
      if (!(privacy === "Private" || privacy === "Hidden")) {
        console.log("[notifyJoinRequest] groupType not Private/Hidden:", privacy);
        return null;
      }

      // 1) Write an in-app notification for creator
      const notifRef = db.ref(`/notifications/${creatorId}`).push();
      const payload = {
        id: notifRef.key,
        type: "group:join_request",
        groupId,
        groupTitle: group.title || "",
        privacy,
        fromUid: requesterUid,
        fromName: joinReq.name || "",
        fromPhoto: joinReq.photoURL || "",
        createdAt: Date.now(),
        read: false,
      };
      await notifRef.set(payload);

      // (Optional) also create an inbox thread if you use it in UI
      await db
        .ref(`/userInboxes/${creatorId}/groupJoinRequests/${groupId}/${requesterUid}`)
        .set({ ...payload, requestedAt: Date.now() });

      // 2) Send FCM push to the creator (scoped by hostel)
      // Reuses your hostel-based token tree + helper
      const tokens = await tokensForUser(hostelid, creatorId);
      if (!tokens.length) {
        console.log("[notifyJoinRequest] no creator tokens found");
        return null;
      }

      const message = {
        notification: {
          title: "New join request",
          body: `${payload.fromName || "Someone"} requested to join "${payload.groupTitle || "your group"}"`,
        },
        data: {
          type: "group:join_request",
          screen: "AcademicGroup",       // customize for your nav
          groupId,
          hostelid: hostelid || "",
        },
      };

      // Chunked send (keeps consistency with your other senders)
      const chunkSize = 500;
      for (let i = 0; i < tokens.length; i += chunkSize) {
        const batch = tokens.slice(i, i + chunkSize);
        await admin.messaging().sendEachForMulticast({ tokens: batch, ...message });
      }
      console.log("[notifyJoinRequest] push sent to creator:", creatorId);

      return null;
    } catch (err) {
      console.error("[notifyJoinRequest] error:", err && err.message ? err.message : String(err));
      return null;
    }
  }
);

// ========== Groups: join approved (notify requester) ==========
exports.notifyJoinApproved = onValueCreated(
  "/groups/{groupId}/joinRequests/{requesterUid}/status",
  async (event) => {
    const { groupId, requesterUid } = event.params;
    const status = (event.data.val() || '').toLowerCase();
    if (status !== 'approved') return null;

    // group load
    const gSnap = await getDatabase().ref(`/groups/${groupId}`).once('value');
    const group = gSnap.val() || {};
    const hostelid = group.hostelid || '';
    const title = group.title || 'Group';

    // requester ke tokens (aapke helpers ke saath)
    const tokens = await tokensForUser(hostelid, requesterUid);
    if (!tokens.length) return null;

    // in-app notification bhi likh do (server-authoritative)
    const notifRef = getDatabase().ref(`/notifications/${requesterUid}`).push();
    await notifRef.set({
      id: notifRef.key,
      type: 'group:join_approved',
      groupId,
      groupTitle: title,
      createdAt: Date.now(),
      read: false,
    });

    const message = {
      notification: {
        title: 'Request approved',
        body: `You can now chat in "${title}"`,
      },
      data: {
        type: 'group:join_approved',
        screen: 'GroupChat',
        groupId,
        groupTitle: title,
      },
    };

    const chunkSize = 500;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const batch = tokens.slice(i, i + chunkSize);
      await admin.messaging().sendEachForMulticast({ tokens: batch, ...message });
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

      await admin.firestore().collection("invites").doc(token).set({
        gid,
        createdBy: uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt,
        maxUses,
        uses: 0,
        active: true,
      });

      // IMPORTANT: include g + t so your RN parse matches
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

      const inviteRef = fsdb.collection("invites").doc(tokenId);
      const snap = await inviteRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Invite not found" });
      }

      const invite = snap.data() || {};
      const now = Date.now();

      if (!invite.active)          return res.status(400).json({ error: "Invite is inactive" });
      if (invite.expiresAt && invite.expiresAt < now)
        return res.status(400).json({ error: "Invite expired" });
      if (invite.gid !== gid)      return res.status(400).json({ error: "Invite does not match this group" });
      if (invite.maxUses && invite.uses >= invite.maxUses)
        return res.status(400).json({ error: "Invite max uses reached" });

      const memberPath = `/discovergroup/${gid}/members/${uid}`;

      // optional: avoid duplicate
      const existing = await db.ref(memberPath).once("value");
      if (!existing.exists()) {
        await db.ref(memberPath).set({
          uid,
          isAdmin: false,
          joinedAt: Date.now(),
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
