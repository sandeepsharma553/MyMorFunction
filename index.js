const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {onValueCreated} = require("firebase-functions/v2/database");
const {getDatabase} = require("firebase-admin/database");
admin.initializeApp();


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
  const snapshot = event.data;
  const messageData = snapshot.val();

  const groupName = messageData.groupName;
  const senderId = messageData.senderId;
  const senderName = messageData.sender || "Someone";
  const messageText = messageData.text || "";

  const db = getDatabase();
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

  const payload = {
    notification: {
      title: groupName,
      body: `${senderName}: ${messageText}`,
    },
  };

  // const messaging = getMessaging();
  // return messaging.sendToDevice(tokens, payload);
  const multicastMessage = {
    tokens: tokens, // array of registration tokens (FCM tokens)
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
