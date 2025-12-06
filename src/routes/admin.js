import express from 'express';
import { generateToken, authMiddleware } from '../auth/jwt.js';
import tokenManager from '../auth/token_manager.js';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
import logger from '../utils/logger.js';
import { generateProjectId } from '../utils/idGenerator.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '../../.env');
const configJsonPath = path.join(__dirname, '../../config.json');

const router = express.Router();

// 登录接口
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === config.admin.username && password === config.admin.password) {
    const token = generateToken({ username, role: 'admin' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
});

// Token管理API - 需要JWT认证
router.get('/tokens', authMiddleware, (req, res) => {
  const tokens = tokenManager.getTokenList();
  res.json({ success: true, data: tokens });
});

router.post('/tokens', authMiddleware, (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, projectId } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token和refresh_token必填' });
  }
  const tokenData = { access_token, refresh_token, expires_in };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (projectId) tokenData.projectId = projectId;
  
  const result = tokenManager.addToken(tokenData);
  res.json(result);
});

router.put('/tokens/:refreshToken', authMiddleware, (req, res) => {
  const { refreshToken } = req.params;
  const updates = req.body;
  const result = tokenManager.updateToken(refreshToken, updates);
  res.json(result);
});

router.delete('/tokens/:refreshToken', authMiddleware, (req, res) => {
  const { refreshToken } = req.params;
  const result = tokenManager.deleteToken(refreshToken);
  res.json(result);
});

router.post('/tokens/reload', authMiddleware, async (req, res) => {
  try {
    await tokenManager.reload();
    res.json({ success: true, message: 'Token已热重载' });
  } catch (error) {
    logger.error('热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/oauth/exchange', authMiddleware, async (req, res) => {
  const { code, port } = req.body;
  if (!code || !port) {
    return res.status(400).json({ success: false, message: 'code和port必填' });
  }
  
  const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
  const CLIENT_SECRET = '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';
  
  try {
    const postData = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      grant_type: 'authorization_code'
    });
    
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: postData.toString()
    });
    
    const tokenData = await response.json();
    
    if (!tokenData.access_token) {
      return res.status(400).json({ success: false, message: 'Token交换失败' });
    }
    
    const account = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      timestamp: Date.now(),
      enable: true
    };
    
    if (config.skipProjectIdFetch) {
      account.projectId = generateProjectId();
      logger.info('使用随机生成的projectId: ' + account.projectId);
    } else {
      try {
        const projectResponse = await axios({
          method: 'POST',
          url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
          headers: {
            'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
            'User-Agent': 'antigravity/1.11.9 windows/amd64',
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip'
          },
          data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
          timeout: config.timeout,
          proxy: config.proxy ? (() => {
            const proxyUrl = new URL(config.proxy);
            return { protocol: proxyUrl.protocol.replace(':', ''), host: proxyUrl.hostname, port: parseInt(proxyUrl.port) };
          })() : false
        });
        
        const projectId = projectResponse.data?.cloudaicompanionProject;
        if (projectId === undefined) {
          return res.status(400).json({ success: false, message: '该账号无资格使用（无法获取projectId）' });
        }
        account.projectId = projectId;
        logger.info('账号验证通过，projectId: ' + projectId);
      } catch (error) {
        logger.error('验证账号资格失败:', error.message);
        return res.status(500).json({ success: false, message: '验证账号资格失败: ' + error.message });
      }
    }
    
    res.json({ success: true, data: account });
  } catch (error) {
    logger.error('Token交换失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取配置
router.get('/config', authMiddleware, (req, res) => {
  try {
    const envData = {};
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        if (key) envData[key.trim()] = valueParts.join('=').trim();
      }
    });
    
    const jsonData = getConfigJson();
    res.json({ success: true, data: { env: envData, json: jsonData } });
  } catch (error) {
    logger.error('读取配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新配置
router.put('/config', authMiddleware, (req, res) => {
  try {
    const { env: envUpdates, json: jsonUpdates } = req.body;
    
    // 更新 .env（只保留敏感信息）
    if (envUpdates) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      Object.entries(envUpdates).forEach(([key, value]) => {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
          envContent += `\n${key}=${value}`;
        }
      });
      fs.writeFileSync(envPath, envContent, 'utf8');
    }
    
    // 更新 config.json
    if (jsonUpdates) {
      saveConfigJson(jsonUpdates);
    }
    
    // 重新加载环境变量
    dotenv.config({ override: true });
    
    // 更新config对象
    const jsonConfig = getConfigJson();
    config.server.port = jsonConfig.server?.port || 8045;
    config.server.host = jsonConfig.server?.host || '0.0.0.0';
    config.defaults.temperature = jsonConfig.defaults?.temperature || 1;
    config.defaults.top_p = jsonConfig.defaults?.topP || 0.85;
    config.defaults.top_k = jsonConfig.defaults?.topK || 50;
    config.defaults.max_tokens = jsonConfig.defaults?.maxTokens || 8096;
    config.security.apiKey = process.env.API_KEY || null;
    config.timeout = jsonConfig.other?.timeout || 180000;
    config.proxy = process.env.PROXY || null;
    config.systemInstruction = process.env.SYSTEM_INSTRUCTION || '';
    config.skipProjectIdFetch = jsonConfig.other?.skipProjectIdFetch === true;
    config.maxImages = jsonConfig.other?.maxImages || 10;
    config.useNativeAxios = jsonConfig.other?.useNativeAxios !== false;
    config.api.url = jsonConfig.api?.url || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse';
    config.api.modelsUrl = jsonConfig.api?.modelsUrl || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels';
    config.api.noStreamUrl = jsonConfig.api?.noStreamUrl || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent';
    config.api.host = jsonConfig.api?.host || 'daily-cloudcode-pa.sandbox.googleapis.com';
    config.api.userAgent = jsonConfig.api?.userAgent || 'antigravity/1.11.3 windows/amd64';
    
    logger.info('配置已更新并热重载');
    res.json({ success: true, message: '配置已保存并生效（端口/HOST修改需重启）' });
  } catch (error) {
    logger.error('更新配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;