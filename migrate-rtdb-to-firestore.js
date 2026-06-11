/**
 * migrate-rtdb-to-firestore.js
 *
 * One-time script: copies ALL relevant RTDB data into the Firestore
 * named database "mymor-australia" (australia-southeast1).
 *
 * RTDB is never modified — it stays as a backup until you manually delete it.
 *
 * Run:
 *   node migrate-rtdb-to-firestore.js
 *
 * Prerequisites:
 *   1. Place your Firebase service account JSON at ./serviceAccountKey.json
 *   2. npm install firebase-admin   (already in package.json)
 *   3. Set FIREBASE_DATABASE_URL below if different from prod
 */

"use strict";

const admin = require("firebase-admin");
const {getFirestore} = require("firebase-admin/firestore");
const {getDatabase} = require("firebase-admin/database");

// ── Config ────────────────────────────────────────────────────────────────────
const DATABASE_URL = "https://mymor-one-default-rtdb.firebaseio.com";
const FIRESTORE_DB = "mymor-australia"; // named Firestore database in australia-southeast1
const BATCH_LIMIT = 400; // Firestore max is 500; stay under for safety
// ─────────────────────────────────────────────────────────────────────────────

const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL,
});

const rtdb = getDatabase();
const fsdb = getFirestore(admin.app(), FIRESTORE_DB);

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Write an array of {ref, data} pairs to Firestore in capped batches.
 * @param {{ref: object, data: object}[]} ops - Array of Firestore write operations
 */
async function batchSet(ops) {
  if (!ops.length) return;
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = fsdb.batch();
    ops.slice(i, i + BATCH_LIMIT).forEach(({ref, data}) => {
      batch.set(ref, data, {merge: false});
    });
    await batch.commit();
  }
}

/**
 * Read a single RTDB path and return its val (null if missing).
 * @param {string} path - RTDB path to read
 */
async function rtdbGet(path) {
  const snap = await rtdb.ref(path).once("value");
  return snap.val();
}

function log(msg) {
  console.log(`[migrate] ${msg}`);
}

// ── Migrators ─────────────────────────────────────────────────────────────────

/** messages/{groupId}/{msgId}  →  groups/{groupId}/messages/{msgId} */
async function migrateMessages() {
  log("messages …");
  const data = await rtdbGet("/messages");
  if (!data) return log("  messages — empty, skip");
  const ops = [];
  for (const [groupId, msgs] of Object.entries(data)) {
    if (!msgs || typeof msgs !== "object") continue;
    for (const [msgId, msg] of Object.entries(msgs)) {
      if (!msg || typeof msg !== "object") continue;
      ops.push({
        ref: fsdb.collection("groups").doc(groupId).collection("messages").doc(msgId),
        data: {...msg, _migratedFrom: "rtdb"},
      });
    }
  }
  await batchSet(ops);
  log(`  messages — ${ops.length} docs written`);
}

/**
 * announcements/{id}  →  announcements/{id}  (doc)
 *   + /comments/{commentId}          (subcollection)
 *   + /comments/{cId}/replies/{rId}  (sub-subcollection)
 * Nested likes maps are kept as fields on each doc.
 */
async function migrateAnnouncements() {
  log("announcements …");
  const data = await rtdbGet("/announcements");
  if (!data) return log("  announcements — empty, skip");

  const mainOps = [];
  const commentOps = [];
  const replyOps = [];

  for (const [annId, ann] of Object.entries(data)) {
    if (!ann || typeof ann !== "object") continue;
    const {comments: rawComments, ...annFields} = ann;

    // Top-level doc (likes are already a map inside annFields)
    mainOps.push({
      ref: fsdb.collection("announcements").doc(annId),
      data: {...annFields, _migratedFrom: "rtdb"},
    });

    if (rawComments && typeof rawComments === "object") {
      for (const [cId, comment] of Object.entries(rawComments)) {
        if (!comment || typeof comment !== "object") continue;
        const {replies: rawReplies, ...commentFields} = comment;

        commentOps.push({
          ref: fsdb.collection("announcements").doc(annId).collection("comments").doc(cId),
          data: {...commentFields, _migratedFrom: "rtdb"},
        });

        if (rawReplies && typeof rawReplies === "object") {
          for (const [rId, reply] of Object.entries(rawReplies)) {
            if (!reply || typeof reply !== "object") continue;
            replyOps.push({
              ref: fsdb.collection("announcements").doc(annId)
                  .collection("comments").doc(cId)
                  .collection("replies").doc(rId),
              data: {...reply, _migratedFrom: "rtdb"},
            });
          }
        }
      }
    }
  }

  await batchSet(mainOps);
  await batchSet(commentOps);
  await batchSet(replyOps);
  log(`  announcements — ${mainOps.length} posts, ${commentOps.length} comments, ${replyOps.length} replies`);
}

/**
 * community/{postId}  →  community/{postId}  (flat, same as RTDB)
 *   + /comments/{cId}
 *   + /comments/{cId}/replies/{rId}
 */
async function migrateCommunity() {
  log("community …");
  const data = await rtdbGet("/community");
  if (!data) return log("  community — empty, skip");

  const mainOps = [];
  const commentOps = [];
  const replyOps = [];

  for (const [postId, post] of Object.entries(data)) {
    if (!post || typeof post !== "object") continue;
    const {comments: rawComments, ...postFields} = post;

    mainOps.push({
      ref: fsdb.collection("community").doc(postId),
      data: {...postFields, _migratedFrom: "rtdb"},
    });

    if (rawComments && typeof rawComments === "object") {
      for (const [cId, comment] of Object.entries(rawComments)) {
        if (!comment || typeof comment !== "object") continue;
        const {replies: rawReplies, ...commentFields} = comment;

        commentOps.push({
          ref: fsdb.collection("community").doc(postId).collection("comments").doc(cId),
          data: {...commentFields, _migratedFrom: "rtdb"},
        });

        if (rawReplies && typeof rawReplies === "object") {
          for (const [rId, reply] of Object.entries(rawReplies)) {
            if (!reply || typeof reply !== "object") continue;
            replyOps.push({
              ref: fsdb.collection("community").doc(postId)
                  .collection("comments").doc(cId)
                  .collection("replies").doc(rId),
              data: {...reply, _migratedFrom: "rtdb"},
            });
          }
        }
      }
    }
  }

  await batchSet(mainOps);
  await batchSet(commentOps);
  await batchSet(replyOps);
  log(`  community — ${mainOps.length} posts, ${commentOps.length} comments, ${replyOps.length} replies`);
}

/**
 * groups/{groupId}  →  groups/{groupId}  (doc)
 *   + /members/{uid}       (subcollection)
 *   + /joinRequests/{uid}  (subcollection)
 *   + /pinnedMessages/{id} (subcollection)
 */
async function migrateGroups() {
  log("groups …");
  const data = await rtdbGet("/groups");
  if (!data) return log("  groups — empty, skip");

  const groupOps = [];
  const memberOps = [];
  const joinOps = [];
  const pinOps = [];

  for (const [groupId, group] of Object.entries(data)) {
    if (!group || typeof group !== "object") continue;
    const {members: rawMembers, joinRequests: rawJoin, pinnedMessages: rawPins, ...groupFields} = group;

    groupOps.push({
      ref: fsdb.collection("groups").doc(groupId),
      data: {...groupFields, _migratedFrom: "rtdb"},
    });

    if (rawMembers && typeof rawMembers === "object") {
      for (const [uid, member] of Object.entries(rawMembers)) {
        memberOps.push({
          ref: fsdb.collection("groups").doc(groupId).collection("members").doc(uid),
          data: typeof member === "object" ? {...member, _migratedFrom: "rtdb"} : {value: member, _migratedFrom: "rtdb"},
        });
      }
    }

    if (rawJoin && typeof rawJoin === "object") {
      for (const [uid, req] of Object.entries(rawJoin)) {
        joinOps.push({
          ref: fsdb.collection("groups").doc(groupId).collection("joinRequests").doc(uid),
          data: typeof req === "object" ? {...req, uid, _migratedFrom: "rtdb"} : {status: req, uid, _migratedFrom: "rtdb"},
        });
      }
    }

    if (rawPins && typeof rawPins === "object") {
      for (const [pinId, pin] of Object.entries(rawPins)) {
        pinOps.push({
          ref: fsdb.collection("groups").doc(groupId).collection("pinnedMessages").doc(pinId),
          data: typeof pin === "object" ? {...pin, _migratedFrom: "rtdb"} : {value: pin, _migratedFrom: "rtdb"},
        });
      }
    }
  }

  await batchSet(groupOps);
  await batchSet(memberOps);
  await batchSet(joinOps);
  await batchSet(pinOps);
  log(`  groups — ${groupOps.length} groups, ${memberOps.length} members, ${joinOps.length} joinRequests, ${pinOps.length} pins`);
}

/**
 * groupUnreadCounts/{groupId}/{uid}  →  groups/{groupId}/unreadCounts/{uid}
 */
async function migrateGroupUnreadCounts() {
  log("groupUnreadCounts …");
  const data = await rtdbGet("/groupUnreadCounts");
  if (!data) return log("  groupUnreadCounts — empty, skip");

  const ops = [];
  for (const [groupId, counts] of Object.entries(data)) {
    if (!counts || typeof counts !== "object") continue;
    for (const [uid, count] of Object.entries(counts)) {
      ops.push({
        ref: fsdb.collection("groups").doc(groupId).collection("unreadCounts").doc(uid),
        data: {count: typeof count === "number" ? count : Number(count) || 0, _migratedFrom: "rtdb"},
      });
    }
  }
  await batchSet(ops);
  log(`  groupUnreadCounts — ${ops.length} docs`);
}

/**
 * discovergroup/{groupId}  →  discovergroup/{groupId}  (doc)
 *   + /members/{uid}  (subcollection)
 * discovergroupmessages/{groupId}/{msgId}  →  discovergroup/{groupId}/messages/{msgId}
 */
async function migrateDiscoverGroups() {
  log("discovergroup …");
  const groupData = await rtdbGet("/discovergroup");
  const msgData = await rtdbGet("/discovergroupmessages");

  const groupOps = [];
  const memberOps = [];
  const msgOps = [];

  if (groupData) {
    for (const [groupId, group] of Object.entries(groupData)) {
      if (!group || typeof group !== "object") continue;
      const {members: rawMembers, ...groupFields} = group;

      groupOps.push({
        ref: fsdb.collection("discovergroup").doc(groupId),
        data: {...groupFields, _migratedFrom: "rtdb"},
      });

      if (rawMembers && typeof rawMembers === "object") {
        for (const [uid, member] of Object.entries(rawMembers)) {
          memberOps.push({
            ref: fsdb.collection("discovergroup").doc(groupId).collection("members").doc(uid),
            data: typeof member === "object" ? {...member, uid, _migratedFrom: "rtdb"} : {uid, _migratedFrom: "rtdb"},
          });
        }
      }
    }
  }

  if (msgData) {
    for (const [groupId, msgs] of Object.entries(msgData)) {
      if (!msgs || typeof msgs !== "object") continue;
      for (const [msgId, msg] of Object.entries(msgs)) {
        if (!msg || typeof msg !== "object") continue;
        msgOps.push({
          ref: fsdb.collection("discovergroup").doc(groupId).collection("messages").doc(msgId),
          data: {...msg, _migratedFrom: "rtdb"},
        });
      }
    }
  }

  await batchSet(groupOps);
  await batchSet(memberOps);
  await batchSet(msgOps);
  log(`  discovergroup — ${groupOps.length} groups, ${memberOps.length} members, ${msgOps.length} messages`);
}

/** discoverannouncements/{id}  →  discoverannouncements/{id} */
async function migrateDiscoverAnnouncements() {
  log("discoverannouncements …");
  const data = await rtdbGet("/discoverannouncements");
  if (!data) return log("  discoverannouncements — empty, skip");

  const ops = [];
  for (const [id, item] of Object.entries(data)) {
    if (!item || typeof item !== "object") continue;
    ops.push({
      ref: fsdb.collection("discoverannouncements").doc(id),
      data: {...item, _migratedFrom: "rtdb"},
    });
  }
  await batchSet(ops);
  log(`  discoverannouncements — ${ops.length} docs`);
}

/** discoverquestions/{groupId}/{qId}  →  discovergroup/{groupId}/questions/{qId} */
async function migrateDiscoverQuestions() {
  log("discoverquestions …");
  const data = await rtdbGet("/discoverquestions");
  if (!data) return log("  discoverquestions — empty, skip");

  const qOps = [];
  const aOps = [];
  const answerData = await rtdbGet("/discoveranswers") || {};

  for (const [groupId, questions] of Object.entries(data)) {
    if (!questions || typeof questions !== "object") continue;
    for (const [qId, q] of Object.entries(questions)) {
      if (!q || typeof q !== "object") continue;
      qOps.push({
        ref: fsdb.collection("discovergroup").doc(groupId).collection("questions").doc(qId),
        data: {...q, _migratedFrom: "rtdb"},
      });
    }
  }

  // discoveranswers/{qId}/{answerId}
  for (const [qId, answers] of Object.entries(answerData)) {
    if (!answers || typeof answers !== "object") continue;
    for (const [aId, answer] of Object.entries(answers)) {
      if (!answer || typeof answer !== "object") continue;
      aOps.push({
        ref: fsdb.collection("discoveranswers").doc(qId).collection("answers").doc(aId),
        data: {...answer, _migratedFrom: "rtdb"},
      });
    }
  }

  await batchSet(qOps);
  await batchSet(aOps);
  log(`  discoverquestions — ${qOps.length} questions, ${aOps.length} answers`);
}

/** discoverreview/{groupId}/{reviewId}  →  discovergroup/{groupId}/reviews/{reviewId} */
async function migrateDiscoverReviews() {
  log("discoverreview …");
  const data = await rtdbGet("/discoverreview");
  if (!data) return log("  discoverreview — empty, skip");

  const ops = [];
  for (const [groupId, reviews] of Object.entries(data)) {
    if (!reviews || typeof reviews !== "object") continue;
    for (const [rId, review] of Object.entries(reviews)) {
      if (!review || typeof review !== "object") continue;
      ops.push({
        ref: fsdb.collection("discovergroup").doc(groupId).collection("reviews").doc(rId),
        data: {...review, _migratedFrom: "rtdb"},
      });
    }
  }
  await batchSet(ops);
  log(`  discoverreview — ${ops.length} docs`);
}

/**
 * social/{groupId}/{postId}  →  social/{groupId}/posts/{postId}
 *   + /comments/{cId}
 *   + /comments/{cId}/replies/{rId}
 */
async function migrateSocial() {
  log("social …");
  const data = await rtdbGet("/social");
  if (!data) return log("  social — empty, skip");

  const postOps = [];
  const commentOps = [];
  const replyOps = [];

  for (const [groupId, posts] of Object.entries(data)) {
    if (!posts || typeof posts !== "object") continue;
    for (const [postId, post] of Object.entries(posts)) {
      if (!post || typeof post !== "object") continue;
      const {comments: rawComments, ...postFields} = post;

      postOps.push({
        ref: fsdb.collection("social").doc(groupId).collection("posts").doc(postId),
        data: {...postFields, groupId, _migratedFrom: "rtdb"},
      });

      if (rawComments && typeof rawComments === "object") {
        for (const [cId, comment] of Object.entries(rawComments)) {
          if (!comment || typeof comment !== "object") continue;
          const {replies: rawReplies, ...commentFields} = comment;

          commentOps.push({
            ref: fsdb.collection("social").doc(groupId).collection("posts").doc(postId)
                .collection("comments").doc(cId),
            data: {...commentFields, _migratedFrom: "rtdb"},
          });

          if (rawReplies && typeof rawReplies === "object") {
            for (const [rId, reply] of Object.entries(rawReplies)) {
              if (!reply || typeof reply !== "object") continue;
              replyOps.push({
                ref: fsdb.collection("social").doc(groupId).collection("posts").doc(postId)
                    .collection("comments").doc(cId)
                    .collection("replies").doc(rId),
                data: {...reply, _migratedFrom: "rtdb"},
              });
            }
          }
        }
      }
    }
  }

  await batchSet(postOps);
  await batchSet(commentOps);
  await batchSet(replyOps);
  log(`  social — ${postOps.length} posts, ${commentOps.length} comments, ${replyOps.length} replies`);
}

/**
 * uniclubs/{clubId}  →  uniclubs/{clubId}  (doc)
 *   + /members/{uid}       (subcollection)
 *   + /joinRequests/{uid}  (subcollection)
 * uniclubsubgroup/{id}  →  uniclubsubgroup/{id}
 */
async function migrateUniClubs() {
  log("uniclubs …");
  const clubData = await rtdbGet("/uniclubs");
  const subgroupData = await rtdbGet("/uniclubsubgroup");

  const clubOps = [];
  const memberOps = [];
  const joinOps = [];
  const subgroupOps = [];

  if (clubData) {
    for (const [clubId, club] of Object.entries(clubData)) {
      if (!club || typeof club !== "object") continue;
      const {members: rawMembers, joinRequests: rawJoin, ...clubFields} = club;

      clubOps.push({
        ref: fsdb.collection("uniclubs").doc(clubId),
        data: {...clubFields, _migratedFrom: "rtdb"},
      });

      if (rawMembers && typeof rawMembers === "object") {
        for (const [uid, member] of Object.entries(rawMembers)) {
          memberOps.push({
            ref: fsdb.collection("uniclubs").doc(clubId).collection("members").doc(uid),
            data: typeof member === "object" ? {...member, uid, _migratedFrom: "rtdb"} : {uid, status: member, _migratedFrom: "rtdb"},
          });
        }
      }

      if (rawJoin && typeof rawJoin === "object") {
        for (const [uid, req] of Object.entries(rawJoin)) {
          joinOps.push({
            ref: fsdb.collection("uniclubs").doc(clubId).collection("joinRequests").doc(uid),
            data: typeof req === "object" ? {...req, uid, _migratedFrom: "rtdb"} : {status: req, uid, _migratedFrom: "rtdb"},
          });
        }
      }
    }
  }

  if (subgroupData) {
    for (const [subId, sub] of Object.entries(subgroupData)) {
      if (!sub || typeof sub !== "object") continue;
      const {members: rawMembers, ...subFields} = sub;
      subgroupOps.push({
        ref: fsdb.collection("uniclubsubgroup").doc(subId),
        data: {...subFields, _migratedFrom: "rtdb"},
      });
      if (rawMembers && typeof rawMembers === "object") {
        for (const [uid, member] of Object.entries(rawMembers)) {
          memberOps.push({
            ref: fsdb.collection("uniclubsubgroup").doc(subId).collection("members").doc(uid),
            data: typeof member === "object" ? {...member, uid, _migratedFrom: "rtdb"} : {uid, _migratedFrom: "rtdb"},
          });
        }
      }
    }
  }

  await batchSet(clubOps);
  await batchSet(subgroupOps);
  await batchSet(memberOps);
  await batchSet(joinOps);
  log(`  uniclubs — ${clubOps.length} clubs, ${subgroupOps.length} subgroups, ${memberOps.length} members, ${joinOps.length} joinRequests`);
}

/**
 * chats/{chatId}/messages/{msgId}  →  chats/{chatId}/messages/{msgId}
 * chats/{chatId}/pins/{pinId}      →  chats/{chatId}/pins/{pinId}
 */
async function migrateChats() {
  log("chats …");
  const data = await rtdbGet("/chats");
  if (!data) return log("  chats — empty, skip");

  const msgOps = [];
  const pinOps = [];

  for (const [chatId, chat] of Object.entries(data)) {
    if (!chat || typeof chat !== "object") continue;
    const {messages: rawMsgs, pins: rawPins} = chat;

    if (rawMsgs && typeof rawMsgs === "object") {
      for (const [msgId, msg] of Object.entries(rawMsgs)) {
        if (!msg || typeof msg !== "object") continue;
        msgOps.push({
          ref: fsdb.collection("chats").doc(chatId).collection("messages").doc(msgId),
          data: {...msg, _migratedFrom: "rtdb"},
        });
      }
    }

    if (rawPins && typeof rawPins === "object") {
      for (const [pinId, pin] of Object.entries(rawPins)) {
        pinOps.push({
          ref: fsdb.collection("chats").doc(chatId).collection("pins").doc(pinId),
          data: typeof pin === "object" ? {...pin, _migratedFrom: "rtdb"} : {value: pin, _migratedFrom: "rtdb"},
        });
      }
    }
  }

  await batchSet(msgOps);
  await batchSet(pinOps);
  log(`  chats — ${msgOps.length} messages, ${pinOps.length} pins`);
}

/**
 * dms/conversations/{convId}         →  dms/{convId}  (doc)
 * dms/messages/{convId}/{msgId}      →  dms/{convId}/messages/{msgId}
 */
async function migrateDMs() {
  log("dms …");
  const dmsData = await rtdbGet("/dms");
  if (!dmsData) return log("  dms — empty, skip");

  const convOps = [];
  const msgOps = [];

  const conversations = dmsData.conversations || {};
  const messages = dmsData.messages || {};

  for (const [convId, conv] of Object.entries(conversations)) {
    if (!conv || typeof conv !== "object") continue;
    convOps.push({
      ref: fsdb.collection("dms").doc(convId),
      data: {...conv, _migratedFrom: "rtdb"},
    });
  }

  for (const [convId, msgs] of Object.entries(messages)) {
    if (!msgs || typeof msgs !== "object") continue;
    for (const [msgId, msg] of Object.entries(msgs)) {
      if (!msg || typeof msg !== "object") continue;
      msgOps.push({
        ref: fsdb.collection("dms").doc(convId).collection("messages").doc(msgId),
        data: {...msg, _migratedFrom: "rtdb"},
      });
    }
  }

  await batchSet(convOps);
  await batchSet(msgOps);
  log(`  dms — ${convOps.length} conversations, ${msgOps.length} messages`);
}

/**
 * notifications/{uid}/{notifId}  →  users/{uid}/notifications/{notifId}
 */
async function migrateNotifications() {
  log("notifications …");
  const data = await rtdbGet("/notifications");
  if (!data) return log("  notifications — empty, skip");

  const ops = [];
  for (const [uid, notifs] of Object.entries(data)) {
    if (!notifs || typeof notifs !== "object") continue;
    for (const [nId, notif] of Object.entries(notifs)) {
      if (!notif || typeof notif !== "object") continue;
      ops.push({
        ref: fsdb.collection("users").doc(uid).collection("notifications").doc(nId),
        data: {...notif, _migratedFrom: "rtdb"},
      });
    }
  }
  await batchSet(ops);
  log(`  notifications — ${ops.length} docs`);
}

/**
 * hostelTokens/{hostelid}/{uid}  →  hostelTokens/{hostelid}/tokens/{uid}
 * userTokens/{uid}               →  userTokens/{uid}  (Firestore doc)
 */
async function migrateTokens() {
  log("tokens …");
  const hostelTokens = await rtdbGet("/hostelTokens");
  const userTokens = await rtdbGet("/userTokens");

  const ops = [];

  if (hostelTokens) {
    for (const [hostelid, users] of Object.entries(hostelTokens)) {
      if (!users || typeof users !== "object") continue;
      for (const [uid, val] of Object.entries(users)) {
        let token = null;
        if (typeof val === "string") token = val;
        else if (val && typeof val === "object") token = val.token || Object.values(val).find((v) => typeof v === "string") || null;
        if (!token) continue;
        ops.push({
          ref: fsdb.collection("hostelTokens").doc(hostelid).collection("tokens").doc(uid),
          data: {token, uid, hostelid, _migratedFrom: "rtdb"},
        });
      }
    }
  }

  if (userTokens) {
    for (const [uid, val] of Object.entries(userTokens)) {
      let token = null;
      if (typeof val === "string") token = val;
      else if (val && typeof val === "object") {
        token = val.token || Object.keys(val)[0] || null; // keys are often the FCM token itself
      }
      if (!token) continue;
      ops.push({
        ref: fsdb.collection("userTokens").doc(uid),
        data: {token, uid, _migratedFrom: "rtdb"},
      });
    }
  }

  await batchSet(ops);
  log(`  tokens — ${ops.length} docs`);
}

/**
 * userInboxes/{uid}/groupJoinRequests/{groupId}/{uid2}
 *   →  users/{uid}/inbox/groupJoinRequests/{groupId}_{uid2}
 */
async function migrateUserInboxes() {
  log("userInboxes …");
  const data = await rtdbGet("/userInboxes");
  if (!data) return log("  userInboxes — empty, skip");

  const ops = [];
  for (const [uid, inbox] of Object.entries(data)) {
    if (!inbox || typeof inbox !== "object") continue;
    const gjr = inbox.groupJoinRequests || {};
    for (const [groupId, requests] of Object.entries(gjr)) {
      if (!requests || typeof requests !== "object") continue;
      for (const [uid2, req] of Object.entries(requests)) {
        ops.push({
          ref: fsdb.collection("users").doc(uid).collection("inbox").doc(`${groupId}_${uid2}`),
          data: typeof req === "object" ? {...req, groupId, uid2, _migratedFrom: "rtdb"} : {groupId, uid2, _migratedFrom: "rtdb"},
        });
      }
    }
  }
  await batchSet(ops);
  log(`  userInboxes — ${ops.length} docs`);
}

/**
 * connections/{uid}/{targetUid}  →  users/{uid}/connections/{targetUid}
 */
async function migrateConnections() {
  log("connections …");
  const data = await rtdbGet("/connections");
  if (!data) return log("  connections — empty, skip");

  const ops = [];
  for (const [uid, targets] of Object.entries(data)) {
    if (!targets || typeof targets !== "object") continue;
    for (const [targetUid, val] of Object.entries(targets)) {
      ops.push({
        ref: fsdb.collection("users").doc(uid).collection("connections").doc(targetUid),
        data: typeof val === "object" ? {...val, targetUid, _migratedFrom: "rtdb"} : {connected: val, targetUid, _migratedFrom: "rtdb"},
      });
    }
  }
  await batchSet(ops);
  log(`  connections — ${ops.length} docs`);
}

/**
 * bookmarks / communitybookmarks / discoverbookmarks
 *   {uid}/{itemId}  →  users/{uid}/{collName}/{itemId}
 */
async function migrateBookmarks() {
  log("bookmarks …");
  let total = 0;
  for (const collName of ["bookmarks", "communitybookmarks", "discoverbookmarks"]) {
    const data = await rtdbGet(`/${collName}`);
    if (!data) continue;
    const ops = [];
    for (const [uid, items] of Object.entries(data)) {
      if (!items || typeof items !== "object") continue;
      for (const [itemId, val] of Object.entries(items)) {
        ops.push({
          ref: fsdb.collection("users").doc(uid).collection(collName).doc(itemId),
          data: typeof val === "object" ? {...val, _migratedFrom: "rtdb"} : {value: val, _migratedFrom: "rtdb"},
        });
      }
    }
    await batchSet(ops);
    total += ops.length;
  }
  log(`  bookmarks — ${total} docs total`);
}

/** invites  — already written to Firestore by createInvite function, skip */
async function migrateInvites() {
  log("invites — already in Firestore (default db), skipping");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("  RTDB → Firestore Migration");
  console.log(`  Target: Firestore database "${FIRESTORE_DB}"`);
  console.log("=".repeat(60));
  console.log();
  console.log("NOTE: RTDB data is READ ONLY — nothing is deleted.");
  console.log("      RTDB remains your backup until you manually remove it.");
  console.log();

  try {
    await migrateMessages();
    await migrateAnnouncements();
    await migrateCommunity();
    await migrateGroups();
    await migrateGroupUnreadCounts();
    await migrateDiscoverGroups();
    await migrateDiscoverAnnouncements();
    await migrateDiscoverQuestions();
    await migrateDiscoverReviews();
    await migrateSocial();
    await migrateUniClubs();
    await migrateChats();
    await migrateDMs();
    await migrateNotifications();
    await migrateTokens();
    await migrateUserInboxes();
    await migrateConnections();
    await migrateBookmarks();
    await migrateInvites();

    console.log();
    console.log("=".repeat(60));
    console.log("  Migration complete ✅");
    console.log("  Next steps:");
    console.log("  1. Deploy updated Cloud Functions  (firebase deploy --only functions)");
    console.log("  2. Deploy updated app");
    console.log("  3. Verify everything works");
    console.log("  4. (Later) Delete RTDB data once confirmed stable");
    console.log("=".repeat(60));
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Migration failed:", err);
    process.exit(1);
  }
}

main();
