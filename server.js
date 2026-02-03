import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GoogleGenerativeAI } from "@google/generative-ai"; 

import User from "./models/userModel.js";
import GameLog from "./models/logModel.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ★★★ 修正 1：改回正確的模型名稱 (解決 AI Error 500 問題) ★★★
const MODEL_NAME = "gemini-3-flash-preview"; 

// ★★★ 修正 2：建立管理員白名單 (解決無法進入後台問題) ★★★
// 只要帳號是 lee1030431 或 admin，系統就會強制認定他是管理員
const ADMIN_WHITELIST = ["lee1030431", "admin"];

if (!process.env.GEMINI_API_KEY) console.error("❌ 找不到 GEMINI_API_KEY");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ 
  model: MODEL_NAME,
  systemInstruction: "你是一個貓咪迷宮導航員。規則：黑牆不能走，優先拿寶物。語氣：喵嗚。請用繁體中文回答。"
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.static("public"));

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB Connected");
  } catch (err) { console.error("❌ MongoDB Error", err); }
}
connectDB();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "未授權" });
  try {
    const token = authHeader.split(" ")[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next(); 
  } catch { res.status(403).json({ error: "Token 無效" }); }
}

// 註冊
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: "帳號已存在" });

    const hashed = await bcrypt.hash(password, 10);
    const userCount = await User.countDocuments();
    const assignedGroup = (userCount % 2 === 0) ? 'AI' : 'Control';

    const user = new User({ username, password: hashed, group: assignedGroup });
    await user.save();
    res.json({ message: `註冊成功！分配到 ${assignedGroup} 組` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 登入
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: "帳號不存在" });
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "密碼錯誤" });
    
    // 更新最後登入時間
    user.lastActive = new Date();
    await user.save();

    // ★★★ 強制賦予管理員權限：如果是白名單的人，無視資料庫設定，直接給 admin ★★★
    let finalRole = user.role;
    if (ADMIN_WHITELIST.includes(user.username)) {
        finalRole = "admin";
    }

    const token = jwt.sign({ 
        id: user._id, 
        username: user.username,
        role: finalRole 
    }, process.env.JWT_SECRET, { expiresIn: "24h" });
    
    res.json({ 
        message: "登入成功", token, username: user.username, 
        group: user.group, lastXml: user.lastXml, role: finalRole 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 獲取個人資料
app.get("/api/user-data", authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        
        // ★★★ 再次確認：如果是白名單，告訴前端他是 admin (這樣才會觸發跳轉) ★★★
        let finalRole = user.role;
        if (ADMIN_WHITELIST.includes(user.username)) {
            finalRole = "admin";
        }

        res.json({ username: user.username, group: user.group, lastXml: user.lastXml, role: finalRole });
    } catch (err) { res.status(500).json({ error: "Error" }); }
});

// 儲存進度
app.post("/api/save-progress", authMiddleware, async (req, res) => {
    try {
        const { xml } = req.body;
        await User.findByIdAndUpdate(req.user.id, { lastXml: xml, lastActive: new Date() });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Save failed" }); }
});

// Logs
app.post("/api/logs", authMiddleware, async (req, res) => {
  try {
    const { logs, level } = req.body;
    await User.findByIdAndUpdate(req.user.id, { lastActive: new Date() });

    const logsWithUser = logs.map(l => ({ ...l, username: req.user.username }));
    let gameLog = await GameLog.findOne({ userId: req.user.id, level }).sort({ createdAt: -1 });
    if (!gameLog || (Date.now() - new Date(gameLog.createdAt).getTime() > 7200000)) {
        gameLog = new GameLog({ userId: req.user.id, level, actions: logsWithUser });
        await gameLog.save();
    } else {
        await GameLog.updateOne({ _id: gameLog._id }, { $push: { actions: { $each: logsWithUser } } });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Log failed" }); }
});

// AI
app.post("/api/ask-ai", authMiddleware, async (req, res) => {
  try {
    const { userText, history, gameState } = req.body;
    await User.findByIdAndUpdate(req.user.id, { lastActive: new Date() });

    let chatHistory = [];
    if (history) {
      chatHistory = history.map(msg => ({
        role: (msg.role === 'ai' || msg.role === 'model') ? 'model' : 'user',
        parts: [{ text: msg.parts[0].text }]
      }));
    }
    let context = "";
    if (gameState) context = `地圖:${JSON.stringify(gameState.map)}\n玩家:${JSON.stringify(gameState.player)}\n代碼:\n${gameState.currentCode}`;
    
    // 因為上面改回了 gemini-1.5-flash，這裡就不會再報錯了
    const chat = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(context + "\n使用者: " + userText);
    res.json({ reply: result.response.text() });
  } catch (err) { 
      console.error("AI Error:", err);
      res.status(500).json({ error: err.message }); 
  }
});

// 管理員 API (允許白名單存取)
app.get("/api/admin/users", authMiddleware, async (req, res) => {
    try {
        // ★★★ 權限檢查：只要是白名單，就放行 ★★★
        if (req.user.role !== 'admin' && !ADMIN_WHITELIST.includes(req.user.username)) { 
             return res.status(403).json({ error: "權限不足" });
        }

        const users = await User.find({}, 'username group role lastActive lastXml createdAt').sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: "無法獲取列表" });
    }
});

app.listen(PORT, () => console.log(`🚀 Server running → http://localhost:${PORT}`));
