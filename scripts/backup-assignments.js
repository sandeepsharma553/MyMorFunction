/* Read-only backup of ALL trainingAssignments + checklistAssignments across every
 * group & venue (mymor-australia). These are the docs the auto-assign functions
 * create/touch — a restore point before the Area→Station→Role re-wire.
 *   node scripts/backup-assignments.js
 * STRICTLY READ-ONLY (.get() only). Uses the MyMorAdmin service account (project
 * mymor-one); override with GOOGLE_APPLICATION_CREDENTIALS / RG_SA if needed. */
const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");

const SA = process.env.RG_SA || "/Users/mac/Projects/MyMorAdmin/secrets/serviceAccount.json";
admin.initializeApp({credential: admin.credential.cert(require(SA))});
const {getFirestore} = require("firebase-admin/firestore");
const DB_ID = process.env.RG_DATABASE_ID || "mymor-australia";
const db = getFirestore(admin.app(), DB_ID);

(async () => {
  console.log(`Backup assignments — db=${DB_ID} (READ-ONLY)\n`);
  const training = [];
  const checklist = [];
  let groups = 0; let venues = 0;
  const gSnap = await db.collection("restaurantGroups").get();
  for (const g of gSnap.docs) {
    groups++;
    const vSnap = await g.ref.collection("venues").get();
    for (const v of vSnap.docs) {
      venues++;
      const ta = await v.ref.collection("trainingAssignments").get();
      ta.forEach((d) => training.push({groupId: g.id, venueId: v.id, id: d.id, data: d.data()}));
      const ca = await v.ref.collection("checklistAssignments").get();
      ca.forEach((d) => checklist.push({groupId: g.id, venueId: v.id, id: d.id, data: d.data()}));
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve(__dirname, "../backups");
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, `assignments-${DB_ID}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({
    db: DB_ID, exportedAt: new Date().toISOString(), groups, venues,
    trainingAssignments: training.length, checklistAssignments: checklist.length,
    training, checklist,
  }, null, 2));

  console.log(`groups=${groups} venues=${venues} trainingAssignments=${training.length} checklistAssignments=${checklist.length}`);
  console.log(`written: ${file}`);
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message); process.exit(1);
});
