import mongoose from "mongoose";

const logSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // 🚀 優化 1：直接存入使用者名稱，方便管理員後台查看
  username: { type: String }, 

  // 玩家當前的進度關卡 (Level 1~5)
  level: { type: mongoose.Schema.Types.Mixed, default: 1 },

  // 🚀 論文關鍵欄位：紀錄該玩家最新的表現數據快照
  latestScore: { type: Number, default: 0 },         // 100 分制表現積分
  latestAiRating: { type: String, default: "待評分" }, // 最新 AI 評價標籤
  
  // 🚀 優化 2：增加四維度指標快照
  metrics: {
    functional: { type: Number, default: 0 },
    efficiency: { type: Number, default: 0 },
    ct: { type: Number, default: 0 },
    learning: { type: Number, default: 0 }
  },

  actions: [{
    timestamp: { type: Date, default: Date.now },
    atLevel: { type: mongoose.Schema.Types.Mixed, required: true },
    category: String, // 'BLOCK_CREATE', 'EXECUTE', 'CHAT', 'LEVEL_COMPLETE', 'RESET_GAME'
    details: mongoose.Schema.Types.Mixed,
    
    // 🚀 關鍵新增：100 分制表現分 (當下切片)
    score: { type: Number },     
    
    // 🚀 關鍵新增：10 分制即時行為/認知狀態分數 (供 LSA 分析行為誘發)
    statusScore: { type: Number }, 

    aiRating: { type: String },
    currentLevel: mongoose.Schema.Types.Mixed 
  }],
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 每次存檔前自動更新 updatedAt
logSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const GameLog = mongoose.model("GameLog", logSchema);
export default GameLog;