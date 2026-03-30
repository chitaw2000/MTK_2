const redis = require('redis');
const redisClient = redis.createClient();
redisClient.on('error', (err) => console.log('Redis Error:', err));
redisClient.connect().then(() => console.log("✅ Connected to Redis")).catch(console.error);
module.exports = redisClient;
