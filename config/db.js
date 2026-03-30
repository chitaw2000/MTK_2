const mongoose = require('mongoose');
require('dotenv').config();
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB Connected');
        const Server = require('../models/Server');
        const User = require('../models/User');
        // Initial Data ထည့်ပေးခြင်း (စမ်းသပ်ရန်)
        if (await Server.countDocuments() === 0) {
            await Server.create([
                { groupName: "⭐ VIP Asia", serverName: "SG-VIP-1", serverKey: "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNzU0cx@139.1.1.1:5678/?outline=1" },
                { groupName: "🟢 Standard Free", serverName: "US-Free-1", serverKey: "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNzVVMx@141.3.3.3:5678/?outline=1" }
            ]);
        }
        if (await User.countDocuments() === 0) {
            await User.create({ token: "nyeSkpYVgoPSe3suIRtys8Lhl09xDohZ", name: "Khant Z", currentServer: "SG-VIP-1", usedGB: 12.5, totalGB: 50 });
        }
    } catch (error) { console.error('❌ MongoDB Error:', error); }
};
module.exports = connectDB;
