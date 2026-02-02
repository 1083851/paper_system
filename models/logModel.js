import mongoose from "mongoose";

const logSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  level: { type: Number, default: 1 },
  // actions 陣列用來儲存所有的操作
  actions: [{
    timestamp: Date,
    category: String,
    details: mongoose.Schema.Types.Mixed
  }],
  createdAt: { type: Date, default: Date.now }
});

const GameLog = mongoose.model("GameLog", logSchema);
export default GameLog;