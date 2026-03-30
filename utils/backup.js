const fs = require('fs');
const path = require('path');
const Group = require('../models/Group');
const User = require('../models/User');
const Master = require('../models/Master');

const backupDir = path.join(process.cwd(), 'backups');
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

function getMMTString() {
    const d = new Date();
    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    const mmt = new Date(utc + (3600000 * 6.5)); // UTC+6:30
    const p = n => n.toString().padStart(2, '0');
    return `${mmt.getFullYear()}-${p(mmt.getMonth()+1)}-${p(mmt.getDate())}_${p(mmt.getHours())}-${p(mmt.getMinutes())}-${p(mmt.getSeconds())}`;
}

async function generateFullBackupFile() {
    const groups = await Group.find({});
    const masters = await Master.find({});
    const users = await User.find({});
    
    const data = { type: 'full', date: new Date(), groups, masters, users };
    const filename = `Full_Backup_${getMMTString()}.json`;
    const filePath = path.join(backupDir, filename);
    
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { filePath, filename };
}

module.exports = { generateFullBackupFile, getMMTString, backupDir };
