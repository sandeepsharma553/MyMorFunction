const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {onValueCreated} = require("firebase-functions/v2/database");
const {getDatabase} = require("firebase-admin/database");
const cors = require("cors")({origin: true});
admin.initializeApp();
const db = getDatabase();

// const sgMail = require("@sendgrid/mail");
// sgMail.setApiKey(functions.remoteConfig().sendgrid.key); // Replace this


const nodemailer = require("nodemailer");

// Load email and password from environment config
// const gmailEmail = functions.config().gmail.email;
// const gmailPassword = functions.config().gmail.password;

// Create a transporter using Gmail SMTP
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "chiggy14@gmaill.com",
    pass: "xggf umkg lpwk kbqn",
  },
});

// exports.sendVerificationCode = functions.https.onCall(async (data, context) => {
//   const emailId = data.emailId;
//   console.log(data, "data functions");
//   // if (!emailId) {
//   //   throw new functions.https.HttpsError("invalid-argument", "Email is required.");
//   // }
//   if (!emailId || typeof emailId !== "string" || !emailId.trim()) {
//     throw new functions.https.HttpsError("invalid-argument", "Email is required.");
//   }

//   const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/;
//   if (!emailRegex.test(emailId)) {
//     throw new functions.https.HttpsError("invalid-argument", "Invalid email format.");
//   }
//   const code = Math.floor(100000 + Math.random() * 900000).toString();

//   await admin
//       .firestore()
//       .collection("emailVerifications")
//       .doc(emailId)
//       .set({
//         code,
//         expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes from now
//       });
//   const msg = {
//     to: emailId,
//     from: "chiggy14@gmaill.com", // Replace with verified sender
//     subject: "Your Verification Code",
//     text: `Your verification code is ${code}`,
//   };
//   try {
//     // await sgMail.send(msg);
//     await transporter.sendMail(msg);
//     return {success: true, message: "Code sent."};
//   } catch (error) {
//     console.error("Error sending email:", error);
//     throw new functions.https.HttpsError("internal", "Failed to send email.");
//   }
// });
function validateEmail(email) {
  const re = /\S+@\S+\.\S+/;
  return re.test(email);
}

exports.sendVerificationCode = functions.https.onRequest(async (req, res) => {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({error: "Method Not Allowed"});
  }

  const {email} = req.body;
  console.log("Received email:", email);

  // Validate email
  if (!email || !validateEmail(email)) {
    return res.status(400).json({
      error: {
        message: "Invalid or missing email",
        status: "INVALID_ARGUMENT",
      },
    });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await admin
      .firestore()
      .collection("emailVerifications")
      .doc(email)
      .set({
        code,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes from now
      });

  const msg = {
    to: email,
    from: "chiggy14@gmaill.com", // Replace with verified sender
    subject: "Your Verification Code",
    text: `Your verification code is ${code}`,
  };

  try {
    // await sgMail.send(msg);
    await transporter.sendMail(msg);
    res.json({success: true, message: `Verification code sent to ${email}`});
    return {success: true, message: "Code sent."};
  } catch (error) {
    console.error("Error sending email:", error);
    throw new functions.https.HttpsError("internal", "Failed to send email.");
  }
});


exports.sendGroupMessageNotification = onValueCreated("/messages/{groupId}/{messageId}", async (event) => {
  const {groupId} = event.params;
  const snapshot = event.data;
  const messageData = snapshot.val();

  const groupName = messageData.groupName;
  const senderId = messageData.senderId;
  const senderName = messageData.sender || "Someone";
  const messageText = messageData.text || "";
  const type = messageData.type || "";
  const posterUrl = messageData.posterUrl || "";


  const tokensSnap = await db.ref("/userTokens").once("value");

  const tokens = [];
  tokensSnap.forEach((child) => {
    if (child.key !== senderId && child.val()) {
      tokens.push(child.val());
    }
  });

  if (tokens.length === 0) {
    console.log("No tokens found");
    return null;
  }
  const body =
    !type || type === "text" ?
      `${senderName}: ${messageText || "Sent a message"}` :
      `${senderName} ${{
        image: "sent an image",
        audio: "sent a voice message",
        video: "sent a video",
        event: "created an event",
        poll: "created a poll",
      }[type]
      }`;
  // const payload = {
  //   notification: {
  //     title: groupName,
  //     body: `${senderName}: ${messageText}`,
  //   },
  // };
  const payload = {
    notification: {
      title: groupName,
      body: body,
    },
    data: {
      screen: "GroupChat",
      type: "groupMessage",
      groupId,
      groupName,
      senderId,
      senderName,
      messageType: type,
      messageText,
      posterUrl,
    },
  };

  const multicastMessage = {
    tokens: tokens,
    ...payload,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(multicastMessage);
    console.log(`${response.successCount} messages were sent successfully`);
    return response;
  } catch (error) {
    console.error("Error sending FCM:", error);
    return null;
  }
});
exports.sendAnnouncementsCommentNotification = onValueCreated(
    "/announcements/{announcementId}/comments/{commentId}",
    async (event) => {
      const comment = event.data.val();
      const announcementId = event.params.announcementId;
      const title = comment.title;
      const senderId = comment.senderId;
      const senderName = comment.sender || "Someone";
      const messageText = comment.content || "";

      const announcementSnap = await db.ref(`/announcements/${announcementId}`).get();
      const announcement = announcementSnap.val();

      if (!announcement || senderId === announcement.userId) return;


      const tokensSnap = await db.ref("/userTokens").once("value");

      const tokens = [];
      tokensSnap.forEach((child) => {
        if (child.key !== senderId && child.val()) {
          tokens.push(child.val());
        }
      });
      if (!tokens) return null;

      const safeAnnouncement = {
        id: announcementId,
        title: announcement.title || "",
        description: announcement.description || "",
      };
      console.log(safeAnnouncement, "announcement");
      const payload = {
        notification: {
          title: title,
          body: `${senderName}: ${messageText}`,
        },
        data: {
          screen: "AnnouncementDetail",
          announcementId,
          title,
          senderId,
          senderName,
          messageText,
        },
      };
      const multicastMessage = {
        tokens: tokens,
        ...payload,
      };

      try {
        const response = await admin.messaging().sendEachForMulticast(multicastMessage);
        console.log(`${response.successCount} messages were sent successfully`);
        return response;
      } catch (error) {
        console.error("Error sending notification:", error);
      }
    },
);
exports.sendAnnouncementsReplyNotification = onValueCreated(
    "/announcements/{announcementId}/comments/{commentId}/replies/{replyId}",
    async (event) => {
      const reply = event.data.val();
      const {announcementId, commentId} = event.params;
      const title = reply.title;
      const senderId = reply.senderId;
      const senderName = reply.sender || "Someone";
      const messageText = reply.content || "";

      const commentSnap = await db.ref(`/announcements/${announcementId}/comments/${commentId}`).get();
      const comment = commentSnap.val();

      if (!comment || senderId === comment.uid) return;


      const tokensSnap = await db.ref("/userTokens").once("value");

      const tokens = [];
      tokensSnap.forEach((child) => {
        if (child.key !== senderId && child.val()) {
          tokens.push(child.val());
        }
      });
      if (!tokens) return null;

      const payload = {
        notification: {
          title: title,
          body: `${senderName}: ${messageText}`,
        },
        data: {
          screen: "AnnouncementDetail",
          announcementId,
          title,
          senderId,
          senderName,
          messageText,
          commentId,
        },
      };
      const multicastMessage = {
        tokens: tokens,
        ...payload,
      };

      try {
        const response = await admin.messaging().sendEachForMulticast(multicastMessage);
        console.log(`${response.successCount} messages were sent successfully`);
        return response;
      } catch (error) {
        console.error("Error sending notification:", error);
      }
    },
);
exports.sendCommunitynNewPostNotification = onValueCreated(
    "/community/{postId}",
    async (event) => {
      const post = event.data.val();
      const {postId} = event.params;
      const senderId = post.senderId;
      const senderName = post.sender || "Someone";
      const messageText = post.content || "";

      if (!post || !post.content || !post.senderId) return;
      const tokensSnap = await db.ref("/userTokens").once("value");

      const tokens = [];
      tokensSnap.forEach((child) => {
        if (child.key !== senderId && child.val()) {
          tokens.push(child.val());
        }
      });
      if (!tokens) return null;

      const payload = {
        notification: {
          title: senderName,
          body: `${senderName}: ${messageText.slice(0, 100)}`,
        },
        data: {
          screen: "Community",
          postId,
          type: "new_post",
        },
      };
      const multicastMessage = {
        tokens: tokens,
        ...payload,
      };

      try {
        const response = await admin.messaging().sendEachForMulticast(multicastMessage);
        console.log(`${response.successCount} messages were sent successfully`);
        return response;
      } catch (error) {
        console.error("Error sending notification:", error);
      }
    },
);
exports.sendCommunityCommentNotification = onValueCreated(
    "/community/{postId}/comments/{commentId}",
    async (event) => {
      const comment = event.data.val();
      const {postId} = event.params;
      const senderId = comment.senderId;
      const senderName = comment.sender || "Someone";
      const messageText = comment.content || "";

      const communitySnap = await db.ref(`/community/${postId}`).get();
      const post = communitySnap.val();
      if (!post || comment.senderId === post.uid) return;

      const tokensSnap = await db.ref("/userTokens").once("value");

      const tokens = [];
      tokensSnap.forEach((child) => {
        if (child.key !== senderId && child.val()) {
          tokens.push(child.val());
        }
      });
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
        },
      };
      const multicastMessage = {
        tokens: tokens,
        ...payload,
      };

      try {
        const response = await admin.messaging().sendEachForMulticast(multicastMessage);
        console.log(`${response.successCount} messages were sent successfully`);
        return response;
      } catch (error) {
        console.error("Error sending notification:", error);
      }
    },
);

exports.sendCommunityReplyNotification = onValueCreated(
    "/community/{postId}/comments/{commentId}/replies/{replyId}",
    async (event) => {
      const reply = event.data.val();
      const {postId, commentId} = event.params;
      const senderId = reply.senderId;
      const senderName = reply.sender || "Someone";
      const messageText = reply.content || "";

      const commentSnap = await db.ref(`/community/${postId}/comments/${commentId}`).get();
      const comment = commentSnap.val();

      if (!comment || senderId === comment.uid) return;


      const tokensSnap = await db.ref("/userTokens").once("value");

      const tokens = [];
      tokensSnap.forEach((child) => {
        if (child.key !== senderId && child.val()) {
          tokens.push(child.val());
        }
      });
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
        },
      };
      const multicastMessage = {
        tokens: tokens,
        ...payload,
      };

      try {
        const response = await admin.messaging().sendEachForMulticast(multicastMessage);
        console.log(`${response.successCount} messages were sent successfully`);
        return response;
      } catch (error) {
        console.error("Error sending notification:", error);
      }
    },
);

exports.deleteUserByUid = functions.https.onRequest(
    (req, res) => {
      cors(req, res, async () => {
        try {
          if (req.method !== "POST") {
            return res
                .status(405)
                .json({error: "Method Not Allowed. Use POST."});
          }

          const {uid} = req.body || {};
          console.log(req, "req");
          if (typeof uid !== "string" || !uid.trim()) {
            return res
                .status(400)
                .json({error: "Request body must contain { uid: <string> }"});
          }
          await admin.auth().deleteUser(uid);
          return res
              .status(200)
              .json({success: true, message: `User ${uid} deleted.`});
        } catch (err) {
          console.error("deleteUserByUid:", err);
          if (err.code === "auth/user-not-found") {
            return res.status(404).json({error: "User not found"});
          }

          return res.status(500).json({error: err.message});
        }
      });
    },
);
