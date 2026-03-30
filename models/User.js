const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: String,
    token: String,
    groupName: String,
    totalGB: Number,
    usedGB: Number,
    currentServer: String,
    expireDate: String,
    accessKeys: Object,
    userNo: Number // 🌟 မပြောင်းလဲသော ကိုယ်ပိုင် ID 
});

module.exports = mongoose.model('User', userSchema);
