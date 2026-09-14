import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  
  // 🚀 修改：確保組別名稱與前端邏輯一致 (建議大寫或小寫固定)
  // 'AI' 代表實驗組，'Control' 代表控制組
  group: { type: String, default: 'AI' }, 
  
  // 🚀 關鍵：保留最後一次積木狀態 (不抹除，供還原使用)
  lastXml: { type: String, default: "" },

  // 紀錄玩家最後所在的關卡頁面編號
  currentLevel: { type: Number, default: 1 },

  // ★★★ 核心：多關卡獨立存儲 ★★★
  levels: {
    type: Map,
    of: new mongoose.Schema({
      // 🚀 註解更新：不再抹除。保留該關卡最後一次「成功過關」或「最後離開」的狀態
      xml: { type: String, default: "" },         
      score: { type: Number, default: 0 },         // 100 分制表現分
      statusScore: { type: Number, default: 5 },   // 10 分制認知行為分
      aiRating: { type: String, default: "" },     // AI 評語明細
      
      metrics: {
        functional: { type: Number, default: 0 },
        efficiency: { type: Number, default: 0 },
        ct: { type: Number, default: 0 },
        learning: { type: Number, default: 0 }
      },

      isCompleted: { type: Boolean, default: false },
      
      // 🚀 建議新增：紀錄該關卡總共點擊了幾次「執行」
      // 這對論文中分析「試錯頻率」非常有幫助
      runCount: { type: Number, default: 0 },
      
      // 🚀 建議新增：該關卡的通關時間 (毫秒)
      completionTime: { type: Number, default: 0 } 
    }, { _id: false }),
    default: {}
  },

  // ★★★ 核心：最高解鎖關卡 ★★★
  maxLevelReached: { type: Number, default: 1 },

  role: { type: String, default: 'student' },
  
  // 🚀 建議新增：裝置資訊 (可選)
  // 有助於排查為什麼某些受試者操作異常 (例如用平板或手機)
  deviceInfo: { type: String, default: "desktop" },

  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
export default User;