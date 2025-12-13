import log from './logger.js';
import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import { generateRequestId } from './idGenerator.js';
import os from 'os';


// Simple hash for correlation logging
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}

// Module-level map to track toolCallId -> functionName for matching responses
const toolCallIdToName = new Map();

// Module-level tracking for model family to detect model switches
let lastProcessedModelFamily = null;

// SIGNATURE CACHE: Track valid signatures received from Gemini in current session
// Any signature NOT in this cache is considered stale and should be replaced
const validSignaturesThisSession = new Set();

// Register a signature as valid (called from client.js when receiving Gemini response)
function registerValidSignature(signature) {
  if (signature && signature !== 'skip_thought_signature_validator') {
    validSignaturesThisSession.add(signature);
    log.info(`[SIG-CACHE] Registered valid signature: ${signature.substring(0, 20)}... (cache size: ${validSignaturesThisSession.size})`);
  }
}

// Check if a signature is valid for this session
function isSignatureValid(signature) {
  if (!signature) {
    log.info(`[SIG-VALID-CHECK] sig is falsy, returning false`);
    return false;
  }
  if (signature === 'skip_thought_signature_validator') {
    log.info(`[SIG-VALID-CHECK] sig is skip, returning true`);
    return true;
  }
  const result = validSignaturesThisSession.has(signature);
  log.info(`[SIG-VALID-CHECK] sig=${signature.substring(0, 15)}... inCache=${result}`);
  return result;
}

function getModelFamily(model) {
  if (!model) return 'unknown';
  if (model.includes('claude')) return 'claude';
  if (model.includes('gemini')) return 'gemini';
  return 'other';
}

async function extractImagesFromContent(content, modelName) {
  const result = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        const imageUrl = item.image_url?.url || '';

        // Handle Public URLs for Claude (Async Fetch)
        if (modelName && modelName.includes('claude') && imageUrl.startsWith('http')) {
          try {
            const resp = await fetch(imageUrl);
            if (resp.ok) {
              const buf = await resp.arrayBuffer();
              const base64Data = Buffer.from(buf).toString('base64');
              const mimeType = resp.headers.get('content-type') || 'image/jpeg';
              result.images.push({
                inlineData: {
                  mimeType: mimeType,
                  data: base64Data
                }
              });
              continue; // Skip base64 check
            }
          } catch (e) {
            log.error('Failed to fetch image url:', imageUrl, e);
          }
        }

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: "user",
    parts: [
      {
        text: extracted.text
      },
      ...extracted.images
    ]
  })
}
function handleAssistantMessage(message, antigravityMessages, modelName, msgIndex) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasThinking = !!message.thinking;
  const hasContent = (message.content && message.content.trim() !== '') || hasThinking;

  // DEBUG: Log full message structure for first assistant message
  if (msgIndex === 1) {
    log.warn(`[DEBUG-MSG] MSG[${msgIndex}] FULL STRUCTURE:`, JSON.stringify({
      keys: Object.keys(message),
      hasThinking: hasThinking,
      thinkingKeys: message.thinking ? Object.keys(message.thinking) : null,
      contentType: typeof message.content,
      contentIsArray: Array.isArray(message.content),
      contentSample: Array.isArray(message.content)
        ? message.content.map(p => ({ type: p.type, keys: Object.keys(p) }))
        : (typeof message.content === 'string' ? message.content.substring(0, 100) : null)
    }, null, 2));
  }

  // DEBUG: Log if any cache_control exists in incoming message
  if (message.cache_control) {
    log.warn(`[CACHE_CONTROL] MSG[${msgIndex}] Found cache_control at message level`);
  }
  if (message.thinking && message.thinking.cache_control) {
    log.warn(`[CACHE_CONTROL] MSG[${msgIndex}] Found cache_control in message.thinking`);
  }
  if (Array.isArray(message.content)) {
    message.content.forEach((part, idx) => {
      if (part && part.cache_control) {
        log.warn(`[CACHE_CONTROL] MSG[${msgIndex}] Found cache_control in content[${idx}]`);
      }
    });
  }

  // Get the signature from the FIRST tool call (if any) to share with all parallel calls
  const firstSignature = hasToolCalls && message.tool_calls[0]?.function?.thought_signature;

  const antigravityTools = hasToolCalls ? message.tool_calls.map((toolCall, idx) => {
    // Generate ID if missing, or use existing
    const toolCallId = toolCall.id || `call_${simpleHash(toolCall.function.name + (toolCall.function.arguments || ''))}`;

    // Store mapping for later response matching
    toolCallIdToName.set(toolCallId, toolCall.function.name);

    const part = {
      functionCall: {
        name: toolCall.function.name,
        args: JSON.parse(toolCall.function.arguments || '{}'),
        id: toolCallId // ALWAYS include ID
      }
    };
    // Apply thoughtSignature to ALL parallel function calls in the turn
    // Use the signature from the first call (Gemini only provides it on first)
    // Or use individual signature if available
    const sig = toolCall.function.thought_signature || firstSignature;
    if (sig) {
      part.thoughtSignature = sig;
    }
    const callHash = simpleHash(toolCall.function.name + (toolCall.function.arguments || ''));
    log.debug(`[DEBUG] hash=${callHash} id=${toolCall.id || 'N/A'} Generated Antigravity Tool Part:`, JSON.stringify(part, null, 2));
    return part;
  }) : [];

  if (lastMessage?.role === "model" && hasToolCalls && !hasContent) {
    // If we are merging into a previous model message, we assume the previous message
    // ALREADY has the thinking block if it was required.
    // However, if the previous message was ALSO missing it, we might be propagating the error.
    // But typically merging happens when Stream splits Thought and Tool.
    lastMessage.parts.push(...antigravityTools)
  } else {
    const parts = [];
    if (hasContent) {
      // 1. Structured Thinking (from Router)
      if (message.thinking) {
        log.info(`[THOUGHT-IN] structured thinking found: sig=${message.thinking.signature}`);
        parts.push({
          text: message.thinking.content,
          thought: true,
          thoughtSignature: message.thinking.signature
        });
      }

      const content = (message.content && typeof message.content === 'string') ? message.content.trimEnd() : '';

      // 2. Parse Content for Thinking (Fallback if no structured thinking)
      const thinkMatch = (!message.thinking && modelName && modelName.includes('claude') && content) ? content.match(/<think(?:[\s\S]*?)>([\s\S]*?)<\/think(?:[\s\S]*?)>/) : null;
      if (thinkMatch) {
        log.info(`[THOUGHT-IN] regex match found in content. len=${thinkMatch[0].length}`);
        // Check for signature in attribute (legacy/Gemini) OR markdown comment (hidden)
        let signatureMatch = thinkMatch[0].match(/signature="([^"]+)"/);
        let signature = signatureMatch ? signatureMatch[1] : null;

        let thoughtText = thinkMatch[1].trim();

        // Check for signature in markdown comment inside content: <!-- signature="sig" -->
        const commentMatch = thoughtText.match(/<!-- signature="([^"]+)" -->/);
        if (commentMatch) {
          if (!signature) signature = commentMatch[1];
          // Remove the comment from the visible thought text
          thoughtText = thoughtText.replace(commentMatch[0], '').trim();
        }
        if (thoughtText) {
          const part = { text: thoughtText, thought: true };
          if (!signature) {
            log.warn('[THOUGHT-IN] Regex passed thinking WITHOUT signature! Fallback disabled.');
            // Use 64 bytes of zeros encoded in Base64
            // signature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
          }
          part.thoughtSignature = signature;
          parts.push(part);
        }
        const remainingText = content.replace(thinkMatch[0], "").trim();
        if (remainingText) {
          parts.push({ text: remainingText });
        }
      } else if (!message.thinking && content) {
        // [THOUGHT RESTORE]
        // If the client strips <think> tags but sends the text content, AND we have tool_calls,
        // we must treat this text as the thinking block to satisfy the API.
        const shouldRestoreThinking = isEnableThinking(modelName) && modelName.includes('claude') && hasToolCalls;

        if (shouldRestoreThinking) {
          let restoredSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="; // valid base64 fallback
          let cleanContent = content;

          // Attempt to recover REAL signature from visible text marker
          const sigMatch = content.match(/\[SIG:([^\]]+)\]/);
          if (sigMatch) {
            restoredSig = sigMatch[1];
            cleanContent = content.replace(sigMatch[0], '').trim();
            log.info(`[THOUGHT-RESTORE] Recovered REAL signature from history! SigPrefix=${restoredSig.substring(0, 10)}...`);
          }

          const preview = cleanContent.substring(0, 100).replace(/\n/g, ' ');
          log.info(`[THOUGHT-RESTORE] Converting plain text to thinking block. Content: "${preview}..."`);
          parts.push({
            text: cleanContent,
            thought: true,
            thoughtSignature: restoredSig
          });
        } else {
          // Normal text content
          log.info(`[THOUGHT-IN] Treating content as text. (No regex match)`);
          parts.push({ text: content });
        }
      }
    }

    // SAFETY FIX: Check if we are missing a required thinking block
    // [DISABLED] Replaced by [THOUGHT RESTORE] above, which uses actual content.
    /*
    if (isEnableThinking(modelName) && modelName.includes('claude') && hasToolCalls && !parts.some(p => p.thought === true)) {
      log.warn(`[ThoughtFix] Missing thinking block for ${modelName} with tool_calls. Injecting redacted_thinking.`);
      parts.unshift({
        text: "Thinking Process (automatically added for protocol compliance)",
        thought: true,
        thoughtSignature: "AAAA" // Base64 placeholder (e.g. 0x00 0x00 0x00)
      });
    }
    */

    parts.push(...antigravityTools);

    antigravityMessages.push({
      role: "model",
      parts
    })
  }
}
function handleToolCall(message, antigravityMessages) {
  // Look up function name from our Map
  let functionName = toolCallIdToName.get(message.tool_call_id) || '';

  // Fallback: search in previous model messages if not in Map
  if (!functionName) {
    for (let i = antigravityMessages.length - 1; i >= 0; i--) {
      if (antigravityMessages[i].role === 'model') {
        const parts = antigravityMessages[i].parts;
        for (const part of parts) {
          if (part.functionCall) {
            // This is a fallback - may not be accurate for multiple calls
            functionName = part.functionCall.name;
            break;
          }
        }
        if (functionName) break;
      }
    }
  }

  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      name: functionName,
      id: message.tool_call_id, // Add ID here for Claude compatibility
      response: {
        output: message.content
      }
    }
  };

  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
async function openaiMessageToAntigravity(openaiMessages, modelName) {
  const antigravityMessages = [];
  let systemText = "";
  const extractSystem = modelName && modelName.includes('claude');

  // DEBUG: Log incoming assistant messages to see their structure
  openaiMessages.forEach((msg, i) => {
    if (msg.role === 'assistant') {
      log.info(`[INCOMING-DEBUG] MSG[${i}] thinking=${!!msg.thinking} tool_calls=${msg.tool_calls?.length || 0}`);
      if (msg.tool_calls) {
        msg.tool_calls.forEach((tc, j) => {
          log.info(`[INCOMING-DEBUG] MSG[${i}] TC[${j}] thought_signature=${tc.function?.thought_signature ? 'present' : 'missing'}`);
        });
      }
    }
  });

  // MODEL SWITCH DETECTION: Handle different model requirements
  // Signatures are cryptographically bound to the model that generated them
  const currentFamily = getModelFamily(modelName);

  const isModelSwitch = lastProcessedModelFamily && lastProcessedModelFamily !== currentFamily;
  const isSwitchingToClaude = isModelSwitch && lastProcessedModelFamily === 'gemini' && currentFamily === 'claude';

  // Also detect cold start to Claude with Gemini history
  // Check if current model is Claude and there are thinking blocks in history that are NOT in cache
  const isColdStartToClaude = !lastProcessedModelFamily && currentFamily === 'claude';

  // Check for stale Gemini thinking: thinking that has signature NOT in our cache
  const hasStaleGeminiThinking = openaiMessages.some(msg => {
    if (msg.role !== 'assistant') return false;
    if (msg.thinking && msg.thinking.signature) {
      const sig = msg.thinking.signature;
      return !validSignaturesThisSession.has(sig) && sig !== 'skip_thought_signature_validator';
    }
    if (msg.tool_calls) {
      return msg.tool_calls.some(tc => {
        const sig = tc.function?.thought_signature;
        return sig && !validSignaturesThisSession.has(sig) && sig !== 'skip_thought_signature_validator';
      });
    }
    return false;
  });

  // CRITICAL: Only strip when there's actually stale Gemini thinking (not in cache)
  const shouldStripForClaude = currentFamily === 'claude' && hasStaleGeminiThinking;

  log.info(`[STRIP-DEBUG] coldStart=${isColdStartToClaude}, hasStale=${hasStaleGeminiThinking}, shouldStrip=${shouldStripForClaude}, cacheSize=${validSignaturesThisSession.size}`);

  if (isModelSwitch) {
    log.info(`[MODEL-SWITCH] ${lastProcessedModelFamily} → ${currentFamily}, clearing signature cache`);
    validSignaturesThisSession.clear(); // Clear cache on model switch
  }

  // CRITICAL: For Claude, remove stale Gemini thinking (not in cache)
  // Keep new thinking from current Claude session (in cache)
  if (shouldStripForClaude) {
    log.info(`[STRIP-FOR-CLAUDE] Processing thinking blocks (switch=${isSwitchingToClaude})`);
    openaiMessages.forEach((msg, i) => {
      if (msg.role !== 'assistant') return;

      // 1. Check thinking signature - delete if stale, keep if valid
      if (msg.thinking) {
        const sig = msg.thinking.signature;
        const isValid = sig && (validSignaturesThisSession.has(sig) || sig === 'skip_thought_signature_validator');
        if (!isValid) {
          log.info(`[STRIP-THINK] MSG[${i}] Removing stale Gemini thinking (sig=${sig ? sig.substring(0, 15) + '...' : 'none'})`);
          delete msg.thinking;  // Remove stale thinking
        } else {
          log.info(`[KEEP-THINK] MSG[${i}] Keeping valid session thinking`);
        }
      }

      // 2. Check tool_calls signature - delete if stale, keep if valid
      if (msg.tool_calls) {
        msg.tool_calls.forEach((tc, tcIdx) => {
          if (tc.function && tc.function.thought_signature) {
            const sig = tc.function.thought_signature;
            const isValid = validSignaturesThisSession.has(sig) || sig === 'skip_thought_signature_validator';
            if (!isValid) {
              log.info(`[STRIP-SIG] MSG[${i}] TC[${tcIdx}] Removing stale thought_signature`);
              delete tc.function.thought_signature;
            } else {
              log.info(`[KEEP-SIG] MSG[${i}] TC[${tcIdx}] Keeping valid thought_signature`);
            }
          }
        });
      }

      // 3. Strip <think> blocks from string content if they have stale signatures
      if (typeof msg.content === 'string' && msg.content.includes('<think')) {
        const sigMatch = msg.content.match(/signature="([^"]*)"/);
        const sig = sigMatch ? sigMatch[1] : null;
        const isValid = sig && (validSignaturesThisSession.has(sig) || sig === 'skip_thought_signature_validator');
        if (!isValid) {
          msg.content = msg.content.replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/g, '').trim();
          log.info(`[STRIP-THINK] MSG[${i}] Removed stale <think> from content`);
        }
      }
    });
  }

  log.info(`[SESSION-DEBUG] lastFam=${lastProcessedModelFamily}, currentFam=${currentFamily}, sigCacheSize=${validSignaturesThisSession.size}`);

  // SIGNATURE VALIDATION using cache
  // Replace each signature that is NOT in our cache (stale from previous session)
  // Valid signatures from current session are kept as-is
  openaiMessages.forEach((msg, i) => {
    if (msg.role !== 'assistant') return;

    // Handle structured thinking - check cache for valid signatures
    if (msg.thinking) {
      const sig = msg.thinking.signature;
      log.info(`[SIG-DEBUG] MSG[${i}] msg.thinking exists, sig=${sig ? sig.substring(0, 15) + '...' : 'undefined'}`);

      // Determine if signature is valid (skip value OR in current session cache)
      const isSkip = sig === 'skip_thought_signature_validator';
      const isInCache = sig && validSignaturesThisSession.has(sig);

      if (!sig) {
        // Missing - add skip
        log.info(`[SIG-ADD-THINK] MSG[${i}] thinking.signature missing, adding skip`);
        msg.thinking.signature = "skip_thought_signature_validator";
      } else if (isSkip || isInCache) {
        // Valid - keep it
        log.info(`[SIG-KEEP-THINK] MSG[${i}] thinking.signature valid (skip=${isSkip}, inCache=${isInCache})`);
      } else {
        // Stale - replace with skip
        log.info(`[SIG-REPLACE-THINK] MSG[${i}] thinking.signature stale, replacing with skip`);
        msg.thinking.signature = "skip_thought_signature_validator";
      }
    }

    // Handle tool_calls signatures - BOTH stale AND missing
    if (msg.tool_calls) {
      msg.tool_calls.forEach((tc, tcIdx) => {
        if (tc.function) {
          const sig = tc.function.thought_signature;
          if (!sig) {
            // Signature is completely MISSING - add skip placeholder
            log.info(`[SIG-ADD] MSG[${i}] TC[${tcIdx}] signature is missing, adding skip`);
            tc.function.thought_signature = "skip_thought_signature_validator";
          } else if (!isSignatureValid(sig)) {
            // Signature exists but is stale - replace with skip
            log.info(`[SIG-REPLACE] MSG[${i}] TC[${tcIdx}] signature is stale, replacing`);
            tc.function.thought_signature = "skip_thought_signature_validator";
          } else {
            log.info(`[SIG-KEEP] MSG[${i}] TC[${tcIdx}] sig=${sig.substring(0, 15)}... (valid)`);
          }
        }
      });
    }

    // Handle string content with <think> tags
    if (typeof msg.content === 'string' && msg.content.includes('<think')) {
      const sigMatch = msg.content.match(/signature="([^"]*)"/);
      if (sigMatch && sigMatch[1] && !isSignatureValid(sigMatch[1])) {
        log.info(`[SIG-REPLACE] MSG[${i}] string content signature is stale, replacing`);
        msg.content = msg.content.replace(/signature="[^"]*"/gi, 'signature="skip_thought_signature_validator"');
      }
    }

    // Handle array content
    if (Array.isArray(msg.content)) {
      msg.content.forEach((part, pIdx) => {
        if ((part.type === 'thinking' || part.thinking === true) && part.signature) {
          if (!isSignatureValid(part.signature)) {
            log.info(`[SIG-REPLACE] MSG[${i}] arr[${pIdx}] signature is stale, replacing`);
            part.signature = "skip_thought_signature_validator";
          }
        }
      });
    }
  });
  lastProcessedModelFamily = currentFamily;

  // PREPROCESSING: Strip thinking blocks from assistant messages when followed by non-tool user messages
  // Per Anthropic's rules: "Cache gets invalidated when non-tool-result user content is added, 
  // causing all previous thinking blocks to be stripped"
  // Only applicable for Claude models
  const isClaudeModel = modelName && modelName.includes('claude');
  if (isClaudeModel) {
    for (let i = 0; i < openaiMessages.length; i++) {
      const msg = openaiMessages[i];
      if (msg.role === 'assistant' && msg.thinking) {
        // Check if next message is a user message that is NOT a tool result
        const nextMsg = openaiMessages[i + 1];
        if (nextMsg && nextMsg.role === 'user') {
          // Check if user message is NOT a tool result
          const isToolResult = nextMsg.role === 'tool' ||
            (Array.isArray(nextMsg.content) && nextMsg.content.some(c => c.type === 'tool_result'));

          if (!isToolResult) {
            log.info(`[STRIP-THINKING] MSG[${i}] Stripping thinking block (followed by non-tool user message)`);
            delete msg.thinking;
          }
        }
      }
    }
  }


  for (const message of openaiMessages) {
    if (message.role === "system") {
      if (extractSystem) {
        // Handle both string and array content (Anthropic format sends array of parts)
        let systemContent = '';
        if (typeof message.content === 'string') {
          systemContent = message.content;
        } else if (Array.isArray(message.content)) {
          systemContent = message.content
            .filter(part => part && (part.text || part.type === 'text'))
            .map(part => part.text || '')
            .join('\n');
        }
        systemText += (systemText ? "\n" : "") + systemContent;
      } else {
        // Fallback for non-Claude (Gemini): Treat as user message
        const extracted = await extractImagesFromContent(message.content, modelName);
        handleUserMessage(extracted, antigravityMessages);
      }
    } else if (message.role === "user") {
      const extracted = await extractImagesFromContent(message.content, modelName);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages, modelName, openaiMessages.indexOf(message));
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  }

  return { contents: antigravityMessages, systemInstruction: systemText };
}
function generateGenerationConfig(parameters, enableThinking, actualModelName) {
  const generationConfig = {
    topP: parameters.top_p ?? config.defaults.top_p,
    topK: parameters.top_k ?? config.defaults.top_k,
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: Math.max(parameters.max_tokens ?? config.defaults.max_tokens, enableThinking ? 16384 : 512),
    stopSequences: [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ],
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    }
  }
  if (enableThinking && actualModelName.includes("claude")) {
    delete generationConfig.topP;
  }
  return generationConfig
}
// Recursively sanitize schema for Claude compatibility
function sanitizeSchemaForClaude(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const unsupportedKeys = ['default', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'format', 'examples', 'const'];
  for (const key of unsupportedKeys) { delete schema[key]; }
  if (schema.properties) { for (const prop in schema.properties) { sanitizeSchemaForClaude(schema.properties[prop]); } }
  if (schema.items) { sanitizeSchemaForClaude(schema.items); }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') { sanitizeSchemaForClaude(schema.additionalProperties); }
  return schema;
}

function convertOpenAIToolsToAntigravity(openaiTools, modelName) {
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map((tool) => {
    delete tool.function.parameters.$schema;
    if (modelName && modelName.includes("claude")) { sanitizeSchemaForClaude(tool.function.parameters); }
    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      ]
    }
  })
}

function modelMapping(modelName) {
  if (modelName === "claude-sonnet-4-5-thinking") {
    return "claude-sonnet-4-5";
  } else if (modelName === "claude-opus-4-5") {
    return "claude-opus-4-5-thinking";
  } else if (modelName === "gemini-2.5-flash-thinking") {
    return "gemini-2.5-flash";
  }
  return modelName;
}

function isEnableThinking(modelName) {
  return modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium"
}

async function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {

  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);

  const conversion = await openaiMessageToAntigravity(openaiMessages, actualModelName);
  const combinedSystem = (config.systemInstruction ? config.systemInstruction + "\n" : "") + conversion.systemInstruction;

  return {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents: conversion.contents,
      systemInstruction: {
        role: "user",
        parts: [{ text: combinedSystem }]
      },
      tools: convertOpenAIToolsToAntigravity(openaiTools, actualModelName),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: "antigravity"
  }
}
function getDefaultIp() {
  const interfaces = os.networkInterfaces();
  if (interfaces.WLAN) {
    for (const inter of interfaces.WLAN) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  } else if (interfaces.wlan2) {
    for (const inter of interfaces.wlan2) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  }
  return '127.0.0.1';
}
export {
  generateRequestId,
  generateRequestBody,
  getDefaultIp,
  registerValidSignature
}
