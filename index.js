import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_USERNAME, REPO_NAME } = process.env;
const BRANCH = "main";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GITHUB_REPO_API = `https://api.github.com/repos/${GITHUB_USERNAME}/${REPO_NAME}/contents`;

/* ============================= */
/* GitHub Helpers                */
/* ============================= */

async function getGitHubFile(filePath) {
  const apiUrl = `${GITHUB_REPO_API}/${filePath}`;
  try {
    const res = await axios.get(`${apiUrl}?ref=${BRANCH}`, {
      headers: { 
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json"
      }
    });
    
    // Handle empty file (content is empty string or whitespace)
    if (!res.data.content || res.data.content.trim() === "") {
      console.log(`[GitHub] ${filePath} is empty, initializing`);
      return { data: { files: [] }, sha: res.data.sha };
    }
    
    const content = Buffer.from(res.data.content, "base64").toString("utf-8");
    
    // Handle whitespace-only content
    if (content.trim() === "") {
      return { data: { files: [] }, sha: res.data.sha };
    }
    
    return { data: JSON.parse(content), sha: res.data.sha };
    
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[GitHub] ${filePath} not found, initializing empty`);
      return { data: { files: [] }, sha: null };
    }
    
    // Handle JSON parse errors specifically
    if (err instanceof SyntaxError) {
      console.error(`[GitHub] ${filePath} contains invalid JSON, resetting`);
      // Try to get sha even if content is bad, so we can overwrite it
      try {
        const res = await axios.get(`${apiUrl}?ref=${BRANCH}`, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
        });
        return { data: { files: [] }, sha: res.data.sha };
      } catch (shaErr) {
        return { data: { files: [] }, sha: null };
      }
    }
    
    console.error(`[GitHub] Failed to fetch ${filePath}:`, err.response?.data?.message || err.message);
    throw new Error(`GitHub fetch failed for ${filePath}: ${err.message}`);
  }
}

async function updateGitHubFile(filePath, data, sha, message) {
  const apiUrl = `${GITHUB_REPO_API}/${filePath}`;
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
  
  try {
    await axios.put(
      apiUrl,
      { message, content, sha, branch: BRANCH },
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    console.log(`[GitHub] Updated ${filePath}: ${message}`);
  } catch (err) {
    console.error(`[GitHub] Failed to update ${filePath}:`, err.response?.data?.message || err.message);
    throw new Error(`GitHub update failed for ${filePath}: ${err.message}`);
  }
}

/* ============================= */
/* Atomic Dual-File Update       */
/* ============================= */

async function updateBothFiles(manifest, manifestSha, duplicates, dupSha, operation) {
  let manifestUpdated = false;
  
  try {
    await updateGitHubFile("manifest.json", { files: manifest }, manifestSha, `${operation} manifest`);
    manifestUpdated = true;
    await updateGitHubFile("duplicates.json", { files: duplicates }, dupSha, `${operation} duplicates`);
    return { success: true };
  } catch (err) {
    if (manifestUpdated) {
      console.error("[CRITICAL] Inconsistent state: manifest updated but duplicates failed");
    }
    throw err;
  }
}

/* ============================= */
/* Telegram Helpers              */
/* ============================= */

async function getFreshPath(fileId) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getFile`, {
      params: { file_id: fileId }
    });
    if (!res.data.ok) throw new Error(res.data.description);
    return res.data.result.file_path;
  } catch (err) {
    console.error(`[Telegram] getFile failed for ${fileId}:`, err.message);
    throw new Error(`Failed to get file path: ${err.message}`);
  }
}

async function forwardMessageSafely(chatId, fromChatId, messageId) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/forwardMessage`, {
      params: {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId
      }
    });
    if (!res.data.ok) throw new Error(res.data.description);
    return res.data.result;
  } catch (err) {
    console.error(`[Telegram] Forward failed from ${fromChatId}/${messageId}:`, err.response?.data?.description || err.message);
    return null;
  }
}

async function sendMessage(chatId, text, options = {}) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text.slice(0, 4096),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...options
    });
  } catch (err) {
    console.error(`[Telegram] sendMessage failed:`, err.response?.data?.description || err.message);
  }
}

/* ============================= */
/* File Processing Logic         */
/* ============================= */

function findExistingFile(manifest, duplicates, uniqueId, fileName, fileSize) {
  const inManifest = manifest.find(f => f.telegram_file_unique_id === uniqueId);
  if (inManifest) return { location: 'manifest', file: inManifest, index: manifest.indexOf(inManifest) };
  
  const inDuplicates = duplicates.find(f => f.telegram_file_unique_id === uniqueId);
  if (inDuplicates) return { location: 'duplicates', file: inDuplicates, index: duplicates.indexOf(inDuplicates) };
  
  const nameSizeMatch = manifest.find(f => f.name === fileName && f.file_size === fileSize);
  if (nameSizeMatch) return { location: 'manifest-name-match', file: nameSizeMatch, index: manifest.indexOf(nameSizeMatch) };
  
  return null;
}

function createFileEntry(targetFile, filePath, originMessageId) {
  return {
    name: targetFile.file_name || targetFile.title || `file_${Date.now()}`,
    telegram_file_id: targetFile.file_id,
    telegram_file_unique_id: targetFile.file_unique_id,
    telegram_file_path: filePath,
    mime_type: targetFile.mime_type || null,
    file_size: targetFile.file_size || 0,
    message_id: originMessageId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    refresh_count: 0
  };
}

/* ============================= */
/* Health Check                  */
/* ============================= */

app.get("/", (req, res) => {
  res.json({ 
    status: "running", 
    timestamp: new Date().toISOString(),
    version: "2.0.0"
  });
});

/* ============================= */
/* Main Webhook                  */
/* ============================= */

app.post("/", async (req, res) => {
  const update = req.body;
  const msg = update.channel_post || update.message;
  
  if (!msg) return res.sendStatus(200);
  
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";
  const fileObject = msg.document || msg.audio || msg.video || msg.video_note || msg.voice;
  
  res.sendStatus(200);
  
  try {
    const [{ data: manifestData, sha: manifestSha }, { data: dupData, sha: dupSha }] = await Promise.all([
      getGitHubFile("manifest.json"),
      getGitHubFile("duplicates.json")
    ]);
    
    let manifest = manifestData.files || [];
    let duplicates = dupData.files || [];
    
    const urlMatch = text.match(/https:\/\/t\.me\/([^\/]+)\/(\d+)/);
    
    /* ============================= */
    /* CASE 1 — Add New File         */
    /* ============================= */
    
    if (fileObject || urlMatch) {
      let targetFile = fileObject;
      let originMessageId = msg.message_id;
      
      if (urlMatch && !fileObject) {
        const [, channelUsername, messageIdStr] = urlMatch;
        const messageId = parseInt(messageIdStr, 10);
        
        const forwarded = await forwardMessageSafely(chatId, `@${channelUsername}`, messageId);
        
        if (forwarded) {
          targetFile = forwarded.document || forwarded.audio || forwarded.video || forwarded.video_note || forwarded.voice;
          originMessageId = forwarded.message_id;
        } else {
          await sendMessage(chatId, "⚠️ Could not forward message. Ensure the bot is in the channel and message exists.");
          return;
        }
      }
      
      if (targetFile) {
        const filePath = await getFreshPath(targetFile.file_id);
        const uniqueId = targetFile.file_unique_id;
        const fileName = targetFile.file_name || targetFile.title || `file_${Date.now()}`;
        const fileSize = targetFile.file_size || 0;
        
        const existing = findExistingFile(manifest, duplicates, uniqueId, fileName, fileSize);
        
        let operation;
        let responseText;
        
        if (existing?.location === 'manifest') {
          existing.file.telegram_file_path = filePath;
          existing.file.last_checked_at = new Date().toISOString();
          existing.file.refresh_count = (existing.file.refresh_count || 0) + 1;
          existing.file.updated_at = new Date().toISOString();
          
          operation = "Refresh existing";
          responseText = `🔄 <b>Existing File Refreshed</b>\n\nName: ${escapeHtml(existing.file.name)}\nRefreshed: ${existing.file.refresh_count} times`;
          
        } else if (existing?.location === 'duplicates') {
          const [restored] = duplicates.splice(existing.index, 1);
          restored.telegram_file_path = filePath;
          restored.message_id = originMessageId;
          restored.updated_at = new Date().toISOString();
          restored.restored_from_duplicates = true;
          manifest.push(restored);
          
          operation = "Restore from duplicates";
          responseText = `♻️ <b>File Restored from Duplicates</b>\n\nName: ${escapeHtml(restored.name)}`;
          
        } else if (existing?.location === 'manifest-name-match') {
          duplicates.push({
            ...createFileEntry(targetFile, filePath, originMessageId),
            duplicate_reason: "name_size_match",
            original_file_id: existing.file.telegram_file_id
          });
          
          operation = "Track modified duplicate";
          responseText = `⚠️ <b>Possible Duplicate Detected</b>\n\nName: ${escapeHtml(fileName)}\nStatus: Moved to duplicates (same name/size, different ID)`;
          
        } else {
          manifest.push(createFileEntry(targetFile, filePath, originMessageId));
          operation = "Add new";
          responseText = `✅ <b>New File Added</b>\n\nName: ${escapeHtml(fileName)}\nSize: ${formatBytes(fileSize)}`;
        }
        
        await updateBothFiles(manifest, manifestSha, duplicates, dupSha, operation);
        
        const directLink = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        await sendMessage(chatId, `${responseText}\n\n<a href="${directLink}">Direct Download</a>`);
      }
    }
    
    /* ============================= */
    /* CASE 2 — Refresh by Filename  */
    /* ============================= */
    
    else if (text.length > 2 && !text.startsWith("/")) {
      const searchTerm = text.toLowerCase();
      const fileIndex = manifest.findIndex(f => f.name.toLowerCase().includes(searchTerm));
      
      if (fileIndex !== -1) {
        const file = manifest[fileIndex];
        const newPath = await getFreshPath(file.telegram_file_id);
        
        manifest[fileIndex].telegram_file_path = newPath;
        manifest[fileIndex].last_checked_at = new Date().toISOString();
        manifest[fileIndex].refresh_count = (manifest[fileIndex].refresh_count || 0) + 1;
        manifest[fileIndex].updated_at = new Date().toISOString();
        
        await updateGitHubFile("manifest.json", { files: manifest }, manifestSha, "Manual refresh by filename");
        
        const newLink = `https://api.telegram.org/file/bot${BOT_TOKEN}/${newPath}`;
        await sendMessage(chatId, `🔄 <b>Link Refreshed</b>\n\nFile: ${escapeHtml(file.name)}\nTimes refreshed: ${manifest[fileIndex].refresh_count}\n\n<a href="${newLink}">New Download Link</a>`);
      } else {
        await sendMessage(chatId, `❌ No file found matching "${escapeHtml(text)}"`);
      }
    }
    
    /* ============================= */
    /* CASE 3 — Commands             */
    /* ============================= */
    
    else if (text === "/github" || text === "/status") {
      const totalSize = manifest.reduce((sum, f) => sum + (f.file_size || 0), 0);
      await sendMessage(chatId, 
        `📊 <b>Repository Status</b>\n\n` +
        `Manifest: ${manifest.length} files\n` +
        `Duplicates: ${duplicates.length} files\n` +
        `Total size: ${formatBytes(totalSize)}\n` +
        `Last updated: ${new Date().toLocaleString()}`
      );
    }
    
    else if (text === "/duplicates") {
      if (duplicates.length === 0) {
        await sendMessage(chatId, "✅ No duplicates tracked");
      } else {
        const list = duplicates.slice(0, 10).map((d, i) => 
          `${i + 1}. ${escapeHtml(d.name)} (${d.duplicate_reason || 'unknown'})`
        ).join("\n");
        await sendMessage(chatId, `⚠️ <b>Recent Duplicates</b> (${duplicates.length} total)\n\n${list}${duplicates.length > 10 ? `\n\n...and ${duplicates.length - 10} more` : ''}`);
      }
    }
    
    else if (text === "/help") {
      await sendMessage(chatId, 
        `📖 <b>Commands</b>\n\n` +
        `/github or /status - Show repository stats\n` +
        `/duplicates - List tracked duplicates\n` +
        `/help - Show this message\n\n` +
        `<b>Usage:</b>\n` +
        `• Send file directly to add it\n` +
        `• Send t.me link to import from channel\n` +
        `• Type filename to refresh its download link`
      );
    }
    
  } catch (err) {
    console.error("[Webhook Error]", err);
    await sendMessage(chatId, `❌ <b>Error</b>\n\n${escapeHtml(err.message.slice(0, 200))}`);
  }
});

/* ============================= */
/* Utilities                     */
/* ============================= */

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/* ============================= */
/* Startup                       */
/* ============================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  console.log(`📁 Repo: ${GITHUB_USERNAME}/${REPO_NAME}`);
  console.log(`🌿 Branch: ${BRANCH}`);
  console.log(`🤖 Bot API: ${BOT_TOKEN ? "Configured" : "MISSING"}`);
  console.log(`🔑 GitHub Token: ${GITHUB_TOKEN ? "Configured" : "MISSING"}`);
});
