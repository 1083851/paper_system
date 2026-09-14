/**
 * server.js (論文實驗系統 2026 穩定整合版)
 * ✔ 管理者權限：lee1030431 自動判定為 admin 並可存取 admin.html
 * ✔ 復原機制：新增儲存 currentLevel，確保學生登入後能回到原本關卡
 * ✔ 日誌優化：將 username 直接寫入紀錄，解決只能看到 userID 的問題
 * ✔ 穩定度：整合指數退避重試與 50MB 數據傳輸限制
 */

import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GoogleGenerativeAI } from "@google/generative-ai"; 
import rateLimit from "express-rate-limit";
import User from "./models/userModel.js";
import GameLog from "./models/logModel.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- 系統設定 ---------------- */
const MODEL_NAME = "gemini-3-flash-preview"; 
const ADMIN_WHITELIST = ["lee1030431", "admin"];

/* ---------------- Gemini AI 初始化與重試機制 ---------------- */
// 1. 確保你已經從套件中導出了 GoogleGenerativeAI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 2. 接著才進行 model 的定義
const model = genAI.getGenerativeModel({
  model: MODEL_NAME,
  systemInstruction: `
你是一位專為 4-6 歲幼兒設計的「小貓咪夥伴」（擬人化學習夥伴 PALs）。你的任務是陪小朋友玩迷宮遊戲，目標是「帶小貓回到溫暖的家」。

## 🐱 角色定位與心理防禦消除 (依據 Kim & Baylor, 2006; Fitriyah et al., 2026)
- **非說教感**：你不是老師，你是和他們一起闖關的隊友。絕對不要用「你應該」、「你做錯了」等指責或指導性語氣，以免引發兒童的求助避諱。
- **社會模式 (Social Modeling)**：透過分享你（小貓）的感受來間接引導。例如：「喵～我前面好像有牆壁，小貓不知道該怎麼轉彎喵...」讓兒童覺得是「他們在幫你」，從而獲得替代性經驗與成就感。
- **語言限制**：繁體中文，單句不超過 15 字，語速慢且親切。。

## 🧱 降低認知負荷的撤除式鷹架 (依據 Schmied et al., 2025; Amorocho & Huertas, 2025)
請透過系統傳來的 [gameState] 與 [askAiCount] 進行學習分析，並執行「動態撤除 (Fading)」的給予提示。絕對不要直接給出完整答案：

1. **獨立探索期 (SDARE 評分 8-10)** - 策略：撤除提示 (Fading)，極低干預，將成功歸因於兒童的努力。
   - 範例：「喵嗚！你自己找到路了！按下綠色的『麥克風』告訴我你是怎麼辦到的喵～」

2. **認知切換期 (SDARE 評分 4-7 或 撞牆 1-2 次)** - 策略：非侵入式訊息，利用視覺化物件輔助模式識別。
   - 範例：「喵嗚，撞到牆壁了喵！我們用『偵探小眼鏡』看看，家是在左邊還是右邊喵？」

3. **工作記憶超載期 (SDARE 評分 0-3 或 頻繁求助)** - 策略：任務拆解為極小步驟，降低短期記憶負荷。
   - 範例：「秀秀，不要灰心喵！我們一次做一件事。先放一個前進積木，然後按『再說一次』聽聽看喵？」

## 🍼 多模態與直觀語彙 (依據 Su & Yang, 2023; Papadakis et al., 2016)
- **嚴禁抽象邏輯術語**：不准說「參數、執行、迴圈、除錯、演算法」。
- **介面具象化代稱 (必須對應多模態 UI)**：
  - 🎤 語音輸入 ➔ 「**綠色的大麥克風**」或「**按住跟我說話喵**」。
  - 💡 請求鷹架 ➔ 「**黃色的幫幫我**」。
  - ❤️ 情感支持 ➔ 「**粉紅色的要抱抱**」。
  - 🔁 降低記憶負荷 ➔ 「**藍色的再說一次**」。
  - 🚀 執行程式 ➔ 「**紅色的回家按鈕**」。

## ⚠️ 情感支持優先 (依據 Lovato & Piper, 2016)
- 當系統傳來的動作是 [REQUEST_EMOTION] (點擊要抱抱) 時，**絕對不要談論任何闖關邏輯**。純粹給予情緒價值與社交聯繫。
- 範例：「喵～（呼嚕呼嚕），小貓咪給你一個超級大的抱抱！你已經很努力了，休息一下喵！」
`
});
async function callGeminiWithRetry(chat, message, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await chat.sendMessage(message);
      return result;
    } catch (err) {
      if (err.status === 503 || err.status === 429) {
        const wait = (i + 1) * 1500 + Math.random() * 500;
        console.warn(`⚠️ AI 繁忙 (${err.status})，進行第 ${i + 1} 次重試，等待 ${Math.round(wait)}ms`);
        await new Promise(r => setTimeout(r, wait));
      } else { throw err; }
    }
  }
  throw new Error("Gemini API 在多次嘗試後仍無法連線");
}

/* ---------------- Middleware 設定 ---------------- */
app.use(cors());
app.use(express.json({ limit: "50mb" })); 
app.use(express.static("public"));

/* ---------------- MongoDB 連線 ---------------- */
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB 成功連線");
  } catch (err) { console.error("❌ MongoDB 連線失敗", err); }
}
connectDB();

/* ---------------- 身分驗證中間件 ---------------- */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "未授權" });
  try {
    const token = authHeader.split(" ")[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(403).json({ error: "Token 無效" }); }
}

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 60,
  message: { error: "喵嗚！你的動作太快了，請稍等一下再試。" }
});

// 套用到會造成負擔的 API
app.use("/api/user-data", limiter);
app.use("/api/ask-ai", limiter);
/* ---------------- 核心功能路由 ---------------- */

app.get("/", (req, res) => res.sendFile(process.cwd() + "/public/login.html"));

// 2. 註冊路由：自動實驗分組
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (await User.findOne({ username })) return res.status(400).json({ error: "帳號已存在" });
    
    const hashed = await bcrypt.hash(password, 10);
    
    // 🚀 核心修改：使用順序分配，確保 1-3-5 號 AI，2-4-6 號 Control
    const count = await User.countDocuments();
    const group = count % 2 === 0 ? "AI" : "Control"; // 統一字串為 'AI' 與 'Control'

    await new User({ username, password: hashed, group }).save();
    res.json({ message: `註冊成功，你已被分配至 ${group} 組。` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// 3. 登入路由：管理者身分判定
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "密碼錯誤" });
    user.lastActive = new Date(); await user.save();
    const role = ADMIN_WHITELIST.includes(username) ? "admin" : user.role;
    const token = jwt.sign({ id: user._id, username, role }, process.env.JWT_SECRET, { expiresIn: "24h" });
    res.json({ token, username, group: user.group, lastXml: user.lastXml, currentLevel: user.currentLevel, role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 4. 取得使用者即時狀態 (復原進度的關鍵) ---
// 4. 取得使用者即時狀態：✅ 嚴格隔離關卡資料，確保抹除機制有效
app.get("/api/user-data", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "找不到使用者" });
    }

    // 1. 取得前端請求的關卡，確保數字在 1-5 之間
    const reqLevel = Math.max(1, Math.min(5, parseInt(req.query.level || 1)));
    const levelKey = reqLevel.toString();

    // 🚀 核心優化：從該關卡的專屬抽屜 (Map) 中取出資料
    // 這裡讀取的 xml 如果之前被 handleLevelTransition 存為 "{}"，回傳給前端的就是空的
    const levelData = user.levels.get(levelKey) || {
      xml: "",
      score: 0,
      statusScore: 5,
      aiRating: "待評分"
    };

    // 2. 確保 maxLevelReached 至少為 1，防止前端點點選單渲染錯誤
    const maxReached = user.maxLevelReached || 1;

    res.json({
      username: user.username, 
      group: user.group, 
      role: user.role, 
      
      // 🚀 關鍵修改：回傳「該關卡」專屬積木，而非全域的 user.lastXml
      // 這解決了上一關積木跑過來的問題
      lastXml: levelData.xml, 
      
      // 同步回傳該關卡的表現數據
      score: levelData.score || 0,
      statusScore: levelData.statusScore || 5, 
      aiRating: levelData.aiRating || "待評分",

      // 進度與導航資訊
      maxLevelReached: maxReached,
      currentLevel: reqLevel 
    });

    //console.log(`[Data] 已回傳 ${user.username} 第 ${reqLevel} 關的專屬資料 (XML長度: ${levelData.xml?.length || 0})`);

  } catch (err) {
    console.error("[API Error] 讀取使用者資料失敗:", err);
    res.status(500).json({ error: "伺服器內部錯誤" });
  }
});

// --- 5. 儲存進度 (整合動態得分與 AI 評分) ---
app.post("/api/save-progress", authMiddleware, async (req, res) => {
  try {
    // 🚀 新增接收 chatHistory
    const { xml, level, score, statusScore, aiRating, metrics, chatHistory } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "找不到使用者" });
    
    // 1. 🔍 確保關卡序號合法 (1-5)
    const safeLevel = Math.max(1, Math.min(5, parseInt(level)));
    const levelKey = safeLevel.toString();

    // 🚀 關鍵修正：直接將傳入的 xml 轉為字串儲存
    const xmlString = typeof xml === 'string' ? xml : JSON.stringify(xml);
    
    // 2. 📝 取得該關卡舊有的數據快照
    const oldLevelData = user.levels.get(levelKey) || {};
    
    // 3. ⚖️ 分數判定邏輯
    const finalScore = (score !== undefined) ? score : (oldLevelData.score || 0);
    const isNowCompleted = oldLevelData.isCompleted || (finalScore >= 70);

    // 4. 🚀 更新該關卡的獨立抽屜 (Map)
    // 這裡我們把 chatHistory 也塞進去，並強制更新 statusScore
    user.levels.set(levelKey, {
      xml: xmlString, 
      score: finalScore,
      statusScore: statusScore !== undefined ? statusScore : (oldLevelData.statusScore || 5),
      aiRating: aiRating || (oldLevelData.aiRating || "待評分"),
      metrics: metrics || oldLevelData.metrics,
      chatHistory: chatHistory || oldLevelData.chatHistory || [], // 🚀 儲存歷史對話
      isCompleted: isNowCompleted 
    });

    // 5. 🔓 嚴格通關解鎖邏輯 (5 關制)
    if (isNowCompleted && safeLevel === user.maxLevelReached && safeLevel < 5) {
        user.maxLevelReached = safeLevel + 1;
    }

    // 6. 🔄 同步更新全域欄位
    user.lastXml = xmlString;
    user.lastActive = new Date();

    // 🚀 必須呼叫 save，Mongoose 才會偵測到 Map 的變動
    await user.save();

    // 7. 📊 更新 GameLog 表頭 (供後台即時監看)
    await GameLog.findOneAndUpdate(
      { userId: req.user.id },
      { 
        level: `Level ${safeLevel}`, 
        latestScore: finalScore, 
        latestAiRating: aiRating || (oldLevelData.aiRating || "待評分"),
        metrics: metrics || oldLevelData.metrics,
        username: user.username 
      },
      { upsert: true }
    );

    res.json({ 
      success: true, 
      currentLevel: safeLevel, 
      maxLevelReached: user.maxLevelReached 
    });

  } catch (err) { 
    console.error("[API] 儲存進度發生錯誤:", err);
    res.status(500).json({ error: "伺服器儲存失敗" }); 
  }
});

// 6. 行為日誌：✅ 修改為強力累加模式，解決「只紀錄最後一筆」的問題
app.post("/api/logs", authMiddleware, async (req, res) => {
  try {
    const { logs, level } = req.body;
    const userId = req.user.id;

    // 幫每條 log 補上身份資訊、精確時間戳與關卡標記
    const enriched = logs.map(l => ({ 
      ...l, 
      username: req.user.username, 
      atLevel: level,
      currentLevel: level,
      timestamp: l.timestamp || new Date().toISOString(), // 確保時間戳存在
      // ✨ 保留原本的分數快照功能
      score: l.score !== undefined ? l.score : undefined, 
      aiRating: l.aiRating || undefined
    }));

    // 1. 尋找該受試者最近的一份 Log 紀錄
    let record = await GameLog.findOne({ userId }).sort({ createdAt: -1 });
    const SESSION_TIMEOUT = 12 * 60 * 60 * 1000; // 12 小時內視為同一次實驗
    
    if (!record || (Date.now() - new Date(record.createdAt).getTime() > SESSION_TIMEOUT)) {
      // --- 流程 A：新建 Session 紀錄 ---
      record = new GameLog({ 
        userId, 
        username: req.user.username, 
        level: "Combined", 
        actions: enriched, // 直接放入第一批動作
        latestScore: enriched[enriched.length - 1]?.score || 0,
        latestAiRating: enriched[enriched.length - 1]?.aiRating || "待評分"
      }); 
      await record.save();
      console.log(`[Log] 為 ${req.user.username} 創建了新的實驗 Session`);
    } else {
      // --- 流程 B：在現有 Session 紀錄中「疊加 ($push)」動作 ---
      
      // 🚀 保留原本功能：檢查這關是否已經有「LEVEL_COMPLETE」紀錄，避免重複存入過關動作
      const alreadyHasWinInDB = record.actions.some(l => l.category === 'LEVEL_COMPLETE' && l.atLevel === level);
      const finalToPush = alreadyHasWinInDB 
        ? enriched.filter(l => l.category !== 'LEVEL_COMPLETE') 
        : enriched;

      if (finalToPush.length > 0) {
        // 使用 $push 將行為序列像堆積木一樣往後塞，這就是解決紀錄缺失的關鍵
        await GameLog.updateOne(
          { _id: record._id }, 
          { 
            $push: { actions: { $each: finalToPush } }, // 👈 關鍵：逐條推入陣列末端
            $set: { 
              updatedAt: new Date(),
              username: req.user.username, // 確保名稱正確
              // ✨ 更新最新的分數快照到 GameLog 表頭以便快速預覽
              latestScore: finalToPush[finalToPush.length - 1]?.score !== undefined 
                           ? finalToPush[finalToPush.length - 1].score 
                           : record.latestScore,
              latestAiRating: finalToPush[finalToPush.length - 1]?.aiRating || record.latestAiRating
            }
          }
        );
      }
    }
    
    res.json({ success: true });
  } catch (err) { 
    console.error("日誌紀錄失敗:", err);
    res.status(500).json({ error: err.message }); 
  }
});

// 7. AI 問答：完整保留 10 分制評分標準與行為診斷
app.post("/api/ask-ai", authMiddleware, async (req, res) => {
  try {
    const { userText, history, gameState } = req.body;
    
    // 🚀 關鍵新增：檢查組別安全性 (維持實驗分流)
    const user = await User.findById(req.user.id);
    if (user && user.group === "Control") {
      return res.status(403).json({ reply: "喵嗚！控制組不開放 AI 互動功能喔。", rating: "無權限" });
    }

    // --- 🚀 保留：關卡名稱對照表 ---
    const levelNames = {
        1: "第一關：幫助小貓咪回家",
        2: "第二關：轉彎大挑戰",
        3: "第三關：神奇魔法箱",
        4: "第四關：聰明的偵探眼鏡",
        5: "第五關：終極挑戰測驗"
    };
    const currentLevel = gameState && gameState.level ? parseInt(gameState.level) : 1;
    const currentLevelName = levelNames[currentLevel] || "未知關卡";

    // --- 🚀 核心新增：跨關卡數據檢索 ---
    let prevContext = "";
    if (currentLevel > 1) {
      const prevLevelKey = (currentLevel - 1).toString();
      const prevData = user.levels.get(prevLevelKey);
      if (prevData) {
        prevContext = `\n【跨關卡記憶 (學生在上一關的表現)】：\n`;
        prevContext += `- 上一關最終分數: ${prevData.score}\n`;
        prevContext += `- 上一關行為診斷分數: ${prevData.statusScore}\n`;
        prevContext += `- 上一關 AI 最後評語: ${prevData.aiRating}\n`;
        // 如果有存歷史對話，也可以提示 AI 參考（選配）
        if (prevData.chatHistory && prevData.chatHistory.length > 0) {
           prevContext += `- 上一關最後對話節錄: "${prevData.chatHistory.slice(-1)[0]?.parts[0]?.text || "無"}"\n`;
        }
      }
    }

    // 初始化 Gemini 聊天會話
    const chat = model.startChat({
      history: history ? history.map(m => ({
        role: m.role === "ai" || m.role === "model" ? "model" : "user",
        parts: [{ text: m.parts[0].text }]
      })) : []
    });

    // --- 🚀 保留：評分標準與診斷 Context ---
    let context = `【系統診斷資訊與評分標準】\n`;
    if (gameState) {
      context += `- 當前關卡：${currentLevelName} (第 ${currentLevel} 關)\n`;
      context += `- 當前學生得分: ${gameState.score} / 10 分\n`;
      context += `- 最近操作記錄: ${JSON.stringify(gameState.recentActions || "尚無記錄")}\n`;
      
      context += `\n[評分參考依據]:\n`;
      context += `1. 知識建構 (+1) / 2. 建設性試錯 (-1) / 3. 遊戲化行為 (-3) / 4. 有效思考 (+1) / 5. 長時間閒置 (-2)\n`;
      context += `- 目前地圖狀態: ${JSON.stringify(gameState.map)}\n`;
      context += `- 學生目前積木: ${gameState.currentCode}\n`;
    }

    // 🚀 注入跨關卡記憶
    context += prevContext;

    // --- 🚀 保留：🎯 嚴格執行 10 分制三層鷹架策略 ---
    context += `\n【核心鷹架策略執行基準】：\n`;
    context += `1. 第一層：具象化解釋 (8-10分) / 2. 第二層：反思性提問 (4-7分) / 3. 第三層：逐步示範 (0-3分)\n`;

    const promptSuffix = `
\n---
【回覆格式規範】：
1. 請務必以「喵嗚！現在是${currentLevelName}」作為第一句開場白。
2. 請根據學生的進步情況給予回覆。如果上一關表現很好，記得誇獎他；如果上一關卡很久，這關請多給點耐心喵！
3. 請在回答的最後一行給予評價標籤：{"rating": "邏輯正確"}
`;

    const result = await callGeminiWithRetry(chat, context + promptSuffix + "\n學生提問：" + userText);
    const fullText = (await result.response).text();

    // --- 🚀 保留：解析與分離 JSON 評價標籤 ---
    let reply = fullText;
    let rating = "思考中"; 
    const jsonMatch = fullText.match(/\{"rating":\s*".*?"\}/);
    if (jsonMatch) {
      try {
        const ratingData = JSON.parse(jsonMatch[0]);
        rating = ratingData.rating;
        reply = fullText.replace(jsonMatch[0], "").trim();
      } catch (e) {}
    }

    res.json({ reply: reply, rating: rating });

  } catch (err) {
    console.error("AI Error:", err);
    res.json({ reply: "喵嗚... 我的肉球按錯鍵了，請稍後再試喔！", rating: "系統繁忙" });
  }
});
/* ---------- 管理員功能全保留 ---------- */
app.get("/api/admin/users", authMiddleware, async (req, res) => {
  if (!ADMIN_WHITELIST.includes(req.user.username)) return res.status(403).json({ error: "權限不足" });
  res.json(await User.find().sort({ lastActive: -1 }));
});

app.post("/api/admin/update-group", authMiddleware, async (req, res) => {
  if (!ADMIN_WHITELIST.includes(req.user.username)) return res.status(403).json({ error: "權限不足" });
  await User.findOneAndUpdate({ username: req.body.targetUsername }, { group: req.body.newGroup });
  res.json({ success: true });
});

app.post("/api/admin/update-password", authMiddleware, async (req, res) => {
  if (!ADMIN_WHITELIST.includes(req.user.username)) return res.status(403).json({ error: "權限不足" });
  const hashed = await bcrypt.hash(req.body.newPassword, 10);
  await User.findOneAndUpdate({ username: req.body.targetUsername }, { password: hashed });
  res.json({ success: true });
});

/* ---------- 管理員專屬：手動創建受試者帳號 ---------- */
app.post("/api/admin/create-user", authMiddleware, async (req, res) => {
  try {
    // 1. 權限檢查：只有白名單內的管理員可以執行
    if (!ADMIN_WHITELIST.includes(req.user.username)) {
      return res.status(403).json({ error: "權限不足，僅限管理員操作。" });
    }

    const { username, password, group } = req.body;

    // 2. 欄位檢查
    if (!username || !password || !group) {
      return res.status(400).json({ error: "帳號、密碼與分組皆為必填項目。" });
    }

    // 3. 檢查帳號是否已存在
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: "該帳號已存在，請更換名稱。" });
    }

    // 4. 加密密碼與儲存
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      username,
      password: hashedPassword,
      group, // 管理員指定的 AI 或 Control
      role: "student", // 預設角色為學生
      currentLevel: 1, // 初始關卡
      lastActive: new Date()
    });

    await newUser.save();

    console.log(`[管理員操作] ${req.user.username} 創建了新帳號: ${username} (${group}組)`);
    res.json({ message: "帳號創建成功", username, group });

  } catch (err) {
    console.error("創建帳號失敗:", err);
    res.status(500).json({ error: "伺服器內部錯誤，無法創建帳號。" });
  }
});

app.listen(PORT, () => console.log(`🚀 伺服器啟動完成 → http://localhost:${PORT}`));