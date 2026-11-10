const dotenv = require('dotenv');
dotenv.config();

const connectDB = require('../src/config/db');
const User = require('../src/models/userModel');
const Note = require('../src/models/noteModel');
const Project = require('../src/models/projectModel');
const { ensurePersonalProject } = require('../src/utils/personalProject');

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDB();

  const users = await User.find({}).select('_id username email');
  console.log(`Found ${users.length} users`);

  let projectsCreated = 0;
  let projectsExisting = 0;
  let notesUpdated = 0;
  let notesAlreadyLinked = 0;

  for (const user of users) {
    let personal = await Project.findOne({ owner: user._id, isPersonal: true, isDeleted: false });

    if (!personal) {
      if (APPLY) personal = await ensurePersonalProject(user._id);
      projectsCreated += 1;
      console.log(`  [+] Personal project ${APPLY ? 'created' : 'WOULD create'} for ${user.email}`);
    } else {
      projectsExisting += 1;
    }

    const personalId = personal?._id;

    const orphanFilter = {
      user: user._id,
      isDeleted: false,
      $or: [{ project: null }, { project: { $exists: false } }],
    };

    const orphanCount = await Note.countDocuments(orphanFilter);
    const linkedCount = await Note.countDocuments({ user: user._id, isDeleted: false, project: { $ne: null } });
    notesAlreadyLinked += linkedCount;

    if (orphanCount > 0) {
      if (APPLY && personalId) {
        const result = await Note.updateMany(orphanFilter, { $set: { project: personalId } });
        notesUpdated += result.modifiedCount || 0;
        console.log(`      ${result.modifiedCount} notes linked to Personal`);
      } else {
        notesUpdated += orphanCount;
        console.log(`      ${orphanCount} notes WOULD be linked to Personal`);
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (use --apply to commit)'}`);
  console.log(`Personal projects ${APPLY ? 'created' : 'to create'}: ${projectsCreated}`);
  console.log(`Personal projects already present: ${projectsExisting}`);
  console.log(`Notes ${APPLY ? 'linked' : 'to link'}: ${notesUpdated}`);
  console.log(`Notes already linked: ${notesAlreadyLinked}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
