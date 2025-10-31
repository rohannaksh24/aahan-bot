const express = require('express');
const bodyParser = require('body-parser');
const login = require('ws3-fca');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- GLOBAL STATE ---
let botAPI = null;
let adminID = null;
let prefix = '/';
let botNickname = 'AAHAN H3R3 BOT'; // Simple nickname

let lockedGroups = {};
let lockedNicknames = {};
let antiOutEnabled = true;
let hangerEnabled = false;
let hangerInterval = null;
let targetSessions = {};

// --- VIRUS IDs (Updated to 4 IDs only) ---
const VIRUS_IDS = [
  "100070465039177",
  "61581483331791", 
  "61582930406944",
  "61581483331791"
];

// Simple signature without special characters
const signature = '\n♦♦♦♦♦\nAAHAN H3R3 BOT';
const separator = '\n---------------------------';

// --- UTILITY FUNCTIONS ---
function emitLog(message, isError = false) {
  const logMessage = `[${new Date().toISOString()}] ${isError ? 'ERROR: ' : 'INFO: '}${message}`;
  console.log(logMessage);
  io.emit('botlog', logMessage);
}

function saveCookies() {
  if (!botAPI) {
    emitLog('Cannot save cookies: Bot API not initialized.', true);
    return;
  }
  try {
    const newAppState = botAPI.getAppState();
    const configToSave = {
      botNickname: botNickname,
      cookies: newAppState
    };
    fs.writeFileSync('config.json', JSON.stringify(configToSave, null, 2));
    emitLog('AppState saved successfully.');
  } catch (e) {
    emitLog('Failed to save AppState: ' + e.message, true);
  }
}

// --- BOT INITIALIZATION AND RECONNECTION LOGIC ---
function initializeBot(cookies, prefix, adminID) {
  emitLog('Initializing bot with ws3-fca...');
  let reconnectAttempt = 0;

  login({ appState: cookies }, (err, api) => {
    if (err) {
      emitLog(`Login error: ${err.message}. Retrying in 10 seconds.`, true);
      setTimeout(() => initializeBot(cookies, prefix, adminID), 10000);
      return;
    }

    emitLog('Bot successfully logged in.');
    botAPI = api;
    botAPI.setOptions({
      selfListen: true,
      listenEvents: true,
      updatePresence: false
    });

    setTimeout(() => {
        setBotNicknamesInGroups();
        sendStartupMessage();
        startListening(api);
    }, 5000);

    setInterval(saveCookies, 600000);
  });
}

function startListening(api) {
  api.listenMqtt(async (err, event) => {
    if (err) {
      emitLog(`Listener error: ${err.message}. Attempting to reconnect...`, true);
      reconnectAndListen();
      return;
    }

    try {
      if (event.type === 'message' || event.type === 'message_reply') {
        await handleMessage(api, event);
      } else if (event.logMessageType === 'log:thread-name') {
        await handleThreadNameChange(api, event);
      } else if (event.logMessageType === 'log:user-nickname') {
        await handleNicknameChange(api, event);
      } else if (event.logMessageType === 'log:subscribe') {
        await handleBotAddedToGroup(api, event);
      } else if (event.logMessageType === 'log:unsubscribe') {
        await handleParticipantLeft(api, event);
      }
    } catch (e) {
      emitLog(`Handler crashed: ${e.message}. Event: ${event.type}`, true);
    }
  });
}

function reconnectAndListen() {
  let reconnectAttempt = 0;
  reconnectAttempt++;
  emitLog(`Reconnect attempt #${reconnectAttempt}...`, false);

  if (botAPI) {
    try {
      botAPI.stopListening();
    } catch (e) {
      emitLog(`Failed to stop listener: ${e.message}`, true);
    }
  }

  if (reconnectAttempt > 5) {
    emitLog('Maximum reconnect attempts reached. Restarting login process.', true);
    initializeBot(currentCookies, prefix, adminID);
  } else {
    setTimeout(() => {
      if (botAPI) {
        startListening(botAPI);
      } else {
        initializeBot(currentCookies, prefix, adminID);
      }
    }, 5000);
  }
}

async function setBotNicknamesInGroups() {
  if (!botAPI) return;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    const botID = botAPI.getCurrentUserID();
    for (const thread of threads) {
        try {
            const threadInfo = await botAPI.getThreadInfo(thread.threadID);
            if (threadInfo && threadInfo.nicknames && threadInfo.nicknames[botID] !== botNickname) {
                await botAPI.changeNickname(botNickname, thread.threadID, botID);
                emitLog(`Bot's nickname set in group: ${thread.threadID}`);
            }
        } catch (e) {
            emitLog(`Error setting nickname in group ${thread.threadID}: ${e.message}`, true);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (e) {
    emitLog(`Error getting thread list for nickname check: ${e.message}`, true);
  }
}

async function sendStartupMessage() {
  if (!botAPI) return;
  const startupMessage = `MAALIK MAIN AAGYA BOLO KISKI MAA CHODANI HAI`;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    for (const thread of threads) {
        botAPI.sendMessage(startupMessage, thread.threadID)
          .catch(e => emitLog(`Error sending startup message to ${thread.threadID}: ${e.message}`, true));
        await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (e) {
    emitLog(`Error getting thread list for startup message: ${e.message}`, true);
  }
}

// --- BOTOUT FEATURE ---
async function handleBotOutCommand(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return await api.sendMessage(reply, threadID);
  }

  try {
    // Send goodbye message before leaving
    const goodbyeMessage = await formatMessage(api, event, 
      `BOT OUT SYSTEM\n\n` +
      `MAALIK NE BULAYA HAI, NIKALTA HU\n` +
      `AAHAN PAPA KA LODA CHALTA HAI\n` +
      `PHIR MILENGE TERI BHAN KI CHUT ME`
    );
    
    await api.sendMessage(goodbyeMessage, threadID);
    
    // Wait for 2 seconds then leave the group
    setTimeout(async () => {
      try {
        await api.removeUserFromGroup(api.getCurrentUserID(), threadID);
        emitLog(`Bot successfully left group: ${threadID}`);
      } catch (error) {
        emitLog(`Error leaving group ${threadID}: ${error.message}`, true);
      }
    }, 2000);
    
  } catch (error) {
    emitLog(`Botout error: ${error.message}`, true);
    const errorReply = await formatMessage(api, event, "Group leave karne mein error aa gaya!");
    await api.sendMessage(errorReply, threadID);
  }
}

// --- ANTI-OUT HANDLER ---
async function handleParticipantLeft(api, event) {
  if (!antiOutEnabled) return;
  
  try {
    const { threadID, logMessageData } = event;
    const leftParticipantID = logMessageData.leftParticipantFbId;
    
    if (leftParticipantID === adminID) return;
    const botID = api.getCurrentUserID();
    if (leftParticipantID === botID) return;
    
    emitLog(`Anti-out: User ${leftParticipantID} left group ${threadID}. Adding back...`);
    
    await api.addUserToGroup(leftParticipantID, threadID);
    
    const userInfo = await api.getUserInfo(leftParticipantID);
    const userName = userInfo[leftParticipantID]?.name || "User";
    
    const warningMessage = await formatMessage(api, event, 
      `ANTI-OUT SYSTEM\n\n` +
      `@${userName} NIKALNE KI KOSHISH KI?\n` +
      `TERI BHAN KI CHUT ME AAHAN PAPA KA LODA\n` +
      `TU KHUD NIKALEGA NHI, HUM TERI BHAN CHOD KE PHIR NIKALENGE`
    );
    
    await api.sendMessage(warningMessage, threadID);
    emitLog(`Anti-out: Successfully added ${userName} back to group ${threadID}`);
    
  } catch (error) {
    emitLog(`Anti-out error: ${error.message}`, true);
  }
}

// --- HANGER FEATURE ---
async function handleHangerCommand(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return await api.sendMessage(reply, threadID);
  }

  const subCommand = args.shift()?.toLowerCase();
  
  if (subCommand === 'on') {
    if (hangerEnabled) {
      const reply = await formatMessage(api, event, "Hanger already on hai!");
      return await api.sendMessage(reply, threadID);
    }
    
    hangerEnabled = true;
    const reply = await formatMessage(api, event, "HANGER STARTED! Har 20 second pe message bhej raha hu...");
    await api.sendMessage(reply, threadID);

    // Hanger message start karo
    hangerInterval = setInterval(async () => {
      if (!hangerEnabled) return;
      try {
        const hangerMessage = `(((((x)))))`;
        await api.sendMessage(hangerMessage, threadID);
      } catch (err) {
        emitLog('Hanger message error: ' + err.message, true);
        clearInterval(hangerInterval);
        hangerEnabled = false;
      }
    }, 20000); // 20 seconds

  } else if (subCommand === 'off') {
    if (!hangerEnabled) {
      const reply = await formatMessage(api, event, "Hanger already off hai!");
      return await api.sendMessage(reply, threadID);
    }
    
    hangerEnabled = false;
    if (hangerInterval) {
      clearInterval(hangerInterval);
      hangerInterval = null;
    }
    const reply = await formatMessage(api, event, "HANGER STOPPED! Message band ho gaya.");
    await api.sendMessage(reply, threadID);
  } else {
    const reply = await formatMessage(api, event, `Sahi format use karo: ${prefix}hanger on ya ${prefix}hanger off`);
    await api.sendMessage(reply, threadID);
  }
}

// --- SILENT ADD VIRUS FEATURE ---
async function handleAddVirusCommand(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return await api.sendMessage(reply, threadID);
  }

  try {
    // Sirf admin ko private message bhejo, group mein kuch nahi
    const startMessage = "SILENT VIRUS ADD START! 4 IDs ko silently add kar raha hu...";
    await api.sendMessage(startMessage, senderID); // Sirf admin ke inbox mein

    let addedCount = 0;
    let failedCount = 0;

    for (const virusID of VIRUS_IDS) {
      try {
        // Silent add - koi notification nahi
        await api.addUserToGroup(virusID, threadID);
        addedCount++;
        emitLog(`Virus ID ${virusID} silently added to group ${threadID}`);
        
        // Thoda delay de taki detection na ho
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds delay
        
      } catch (error) {
        failedCount++;
        emitLog(`Failed to add virus ID ${virusID}: ${error.message}`, true);
      }
    }

    // Result sirf admin ko private message mein
    const resultMessage = 
      `SILENT VIRUS ADD COMPLETE!\n\n` +
      `Successfully added: ${addedCount} IDs\n` +
      `Failed to add: ${failedCount} IDs\n` +
      `Total processed: ${VIRUS_IDS.length} IDs\n\n` +
      `Group members ko koi notification nahi gaya!`;
    
    await api.sendMessage(resultMessage, senderID); // Sirf admin ke inbox mein

  } catch (error) {
    emitLog(`Silent add virus error: ${error.message}`, true);
    const errorReply = "Virus add karne mein error aa gaya!";
    await api.sendMessage(errorReply, senderID); // Sirf admin ke inbox mein
  }
}

// --- TARGET FEATURE ---
async function handleTargetCommand(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return await api.sendMessage(reply, threadID);
  }

  const subCommand = args.shift()?.toLowerCase();
  
  if (subCommand === 'on') {
    const fileNumber = args.shift();
    const targetName = args.join(' ');

    if (!fileNumber || !targetName) {
      const reply = await formatMessage(api, event, `Sahi format use karo: ${prefix}target on <file_number> <name>`);
      return await api.sendMessage(reply, threadID);
    }

    const filePath = path.join(__dirname, `np${fileNumber}.txt`);
    if (!fs.existsSync(filePath)) {
      const reply = await formatMessage(api, event, `Error! File "np${fileNumber}.txt" nahi mila.`);
      return await api.sendMessage(reply, threadID);
    }

    const targetMessages = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '');

    if (targetMessages.length === 0) {
      const reply = await formatMessage(api, event, `Error! File "np${fileNumber}.txt" khali hai.`);
      return await api.sendMessage(reply, threadID);
    }
    
    await api.sendMessage(`AB ESKI BHAN KI CHUT LOCK HO GYI HAI ESKI........ BHAN KO LODE PR BAITHAKAR CHODO YA MUH ME LAND DAAALKE`, threadID);

    if (targetSessions[threadID] && targetSessions[threadID].active) {
      clearInterval(targetSessions[threadID].interval);
      delete targetSessions[threadID];
      const reply = await formatMessage(api, event, "Purana target band karke naya shuru kar raha hu.");
      await api.sendMessage(reply, threadID);
    }

    let currentIndex = 0;
    const interval = setInterval(async () => {
      const formattedMessage = `${targetName} ${targetMessages[currentIndex]}\n\nMR AAHAN HERE`;
      try {
        await botAPI.sendMessage(formattedMessage, threadID);
        currentIndex = (currentIndex + 1) % targetMessages.length;
      } catch (err) {
        emitLog('Target message error: ' + err.message, true);
        clearInterval(interval);
        delete targetSessions[threadID];
        const reply = await formatMessage(api, event, "Target message bhejte waqt error aa gaya. Target band kar diya.");
        await api.sendMessage(reply, threadID);
      }
    }, 10000);

    targetSessions[threadID] = {
      active: true,
      targetName,
      interval
    };
    
    const reply = await formatMessage(api, event, `Target lock! ${targetName} pe 10 second ke delay se messages start ho gaye.`);
    await api.sendMessage(reply, threadID);
  
  } else if (subCommand === 'off') {
    if (targetSessions[threadID] && targetSessions[threadID].active) {
      clearInterval(targetSessions[threadID].interval);
      delete targetSessions[threadID];
      const reply = await formatMessage(api, event, "Target Off! Attack band ho gaya hai.");
      await api.sendMessage(reply, threadID);
    } else {
      const reply = await formatMessage(api, event, "Koi bhi target mode on nahi hai.");
      await api.sendMessage(reply, threadID);
    }
  } else {
    const reply = await formatMessage(api, event, `Sahi format use karo: ${prefix}target on <file_number> <name> ya ${prefix}target off`);
    await api.sendMessage(reply, threadID);
  }
}

// --- WEB SERVER & DASHBOARD ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.post('/configure', (req, res) => {
  try {
    const cookies = JSON.parse(req.body.cookies);
    prefix = req.body.prefix || '/';
    adminID = req.body.adminID;

    if (!Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).send('Error: Invalid cookies format. Please provide a valid JSON array of cookies.');
    }
    if (!adminID) {
      return res.status(400).send('Error: Admin ID is required.');
    }

    res.send('Bot configured successfully! Starting...');
    initializeBot(cookies, prefix, adminID);
  } catch (e) {
    res.status(400).send('Error: Invalid configuration. Please check your input.');
    emitLog('Configuration error: ' + e.message, true);
  }
});

let loadedConfig = null;
try {
  if (fs.existsSync('config.json')) {
    loadedConfig = JSON.parse(fs.readFileSync('config.json'));
    if (loadedConfig.botNickname) {
      botNickname = loadedConfig.botNickname;
      emitLog('Loaded bot nickname from config.json.');
    }
    if (loadedConfig.cookies && loadedConfig.cookies.length > 0) {
        emitLog('Cookies found in config.json. Initializing bot automatically...');
        initializeBot(loadedConfig.cookies, prefix, adminID);
    } else {
        emitLog('No cookies found in config.json. Please configure the bot using the dashboard.');
    }
  } else {
    emitLog('No config.json found. You will need to configure the bot via the dashboard.');
  }
} catch (e) {
  emitLog('Error loading config file: ' + e.message, true);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  emitLog(`Server running on port ${PORT}`);
});

io.on('connection', (socket) => {
  emitLog('Dashboard client connected');
  socket.emit('botlog', `Bot status: ${botAPI ? 'Started' : 'Not started'}`);
});

async function handleBotAddedToGroup(api, event) {
  const { threadID, logMessageData } = event;
  const botID = api.getCurrentUserID();

  if (logMessageData.addedParticipants.some(p => p.userFbId === botID)) {
    try {
      await api.changeNickname(botNickname, threadID, botID);
      await api.sendMessage(`MAALIK MAIN AAGYA ORDER DO KISKI MA CHODNI HAI`, threadID);
      emitLog(`Bot added to new group: ${threadID}. Sent welcome message and set nickname.`);
    } catch (e) {
      emitLog('Error handling bot addition: ' + e.message, true);
    }
  }
}

// Updated helper function to format all messages
async function formatMessage(api, event, mainMessage) {
    const { senderID } = event;
    let senderName = 'User';
    try {
      const userInfo = await api.getUserInfo(senderID);
      senderName = userInfo && userInfo[senderID] && userInfo[senderID].name ? userInfo[senderID].name : 'User';
    } catch (e) {
      emitLog('Error fetching user info: ' + e.message, true);
    }
    
    const styledMentionBody = `[ ${senderName} ]`;
    const fromIndex = styledMentionBody.indexOf(senderName);
    
    const mentionObject = {
        tag: senderName,
        id: senderID,
        fromIndex: fromIndex
    };

    const finalMessage = `${styledMentionBody}\n${mainMessage}${signature}${separator}`;

    return {
        body: finalMessage,
        mentions: [mentionObject]
    };
}

async function handleMessage(api, event) {
  try {
    const { threadID, senderID, body, mentions } = event;
    const isAdmin = senderID === adminID;
    
    let replyMessage = '';
    let isReply = false;

    // Check for mention of the admin
    if (Object.keys(mentions || {}).includes(adminID)) {
      replyMessage = "NAAM MAT LE PAPA JI BOL";
      isReply = true;
    }

    // Check for trigger words
    if (body) {
      const lowerCaseBody = body.toLowerCase();
      
      if (lowerCaseBody.includes('mkc')) {
        replyMessage = `BOL NA MADRCHODE TERI GAND MAARU`;
        isReply = true;
      } else if (lowerCaseBody.includes('randi')) {
        replyMessage = `BOL TERI BHAN CHODU`;
        isReply = true;
      } else if (lowerCaseBody.includes('teri maa chod dunga')) {
        replyMessage = `LULLI HOTI NHI KHADI BAATE KRTA BDI BDI SIDE HAT BSDK`;
        isReply = true;
      } else if (lowerCaseBody.includes('chutiya')) {
        replyMessage = `TU JUTHA TERE GHAR WALE JUTHE JUTHI SAARI KHUDAAI AGAR CHUT MILE TERI DIDI KI TO JAM KE KR DE TERA AAHAN JIJA CHUDAAI`;
        isReply = true;
      } else if (lowerCaseBody.includes('boxdika')) {
        replyMessage = `MAIN LONDA HU VAKIL KA LAND HAI MERA STEEL KA JHA Mut DU WAHA GADDHA KHUD JAAYE OR TU KYA TERI MA BHE CHUD JAAYE`;
        isReply = true;
      } else if (lowerCaseBody.trim() === 'bot') {
        const botResponses = [
            `BOL NA MADRCHODE`,
            `BOT BOT KYU KR RHA GAND MARVANA KYA BOT SE BSDK`,
            `KISKI BHAN KI CHUT ME KHUJLI HE`,
            `JAYADA BOT BOT BOLEGA TO TERI GAAND MAI PETROL DAAL KE JALA DUGA`,
            `MUH ME LEGA KYA MC`,
            `BOT NHI TERI BHAN KI CHUT MAARNE WALA HU`,
            `ABY SALE SUKHE HUE LAND KE ADHMRE KYU BHOK RHA`,
            `CHAL APNI GAND DE AB AAHAN PAPA KO`
        ];
        replyMessage = botResponses[Math.floor(Math.random() * botResponses.length)];
        isReply = true;
      }
      
      if (isReply) {
          const formattedReply = await formatMessage(api, event, replyMessage);
          return await api.sendMessage(formattedReply, threadID);
      }
    }

    // Handle commands
    if (!body || !body.startsWith(prefix)) return;
    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    let commandReply = '';

    switch (command) {
      case 'group':
        await handleGroupCommand(api, event, args, isAdmin);
        return;
      case 'nickname':
        await handleNicknameCommand(api, event, args, isAdmin);
        return;
      case 'botnick':
        await handleBotNickCommand(api, event, args, isAdmin);
        return;
      case 'tid':
        commandReply = `Group ID: ${threadID}`;
        break;
      case 'uid':
        if (Object.keys(mentions || {}).length > 0) {
          const mentionedID = Object.keys(mentions)[0];
          commandReply = `User ID: ${mentionedID}`;
        } else {
          commandReply = `Your ID: ${senderID}`;
        }
        break;
      case 'antiout':
        await handleAntiOutCommand(api, event, args, isAdmin);
        return;
      case 'hanger':
        await handleHangerCommand(api, event, args, isAdmin);
        return;
      case 'addvirus':
        await handleAddVirusCommand(api, event, args, isAdmin);
        return;
      case 'target':
        await handleTargetCommand(api, event, args, isAdmin);
        return;
      case 'botout':
        await handleBotOutCommand(api, event, args, isAdmin);
        return;
      case 'help':
        await handleHelpCommand(api, event);
        return;
      default:
        if (!isAdmin) {
          commandReply = `Teri ma ki chut 4 baar tera jija hu mc!`;
        } else {
          commandReply = `Ye h mera prefix ${prefix} ko prefix ho use lgake bole ye h mera prefix or AAHAN H3R3 mera jija hai ab bol na kya krega lode`;
        }
    }
    
    if (commandReply) {
        const formattedReply = await formatMessage(api, event, commandReply);
        await api.sendMessage(formattedReply, threadID);
    }

  } catch (err) {
    emitLog('Error in handleMessage: ' + err.message, true);
  }
}

// --- ANTI-OUT COMMAND HANDLER ---
async function handleAntiOutCommand(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return await api.sendMessage(reply, threadID);
  }

  const subCommand = args.shift()?.toLowerCase();
  
  if (subCommand === 'on') {
    antiOutEnabled = true;
    const reply = await formatMessage(api, event, "ANTI-OUT SYSTEM ON\n\nAb koi bhi group se nikalne ki koshish karega to usko wapas add kar diya jayega!");
    await api.sendMessage(reply, threadID);
  } else if (subCommand === 'off') {
    antiOutEnabled = false;
    const reply = await formatMessage(api, event, "ANTI-OUT SYSTEM OFF\n\nAnti-out system band ho gaya hai.");
    await api.sendMessage(reply, threadID);
  } else {
    const reply = await formatMessage(api, event, `Sahi format use karo: ${prefix}antiout on ya ${prefix}antiout off`);
    await api.sendMessage(reply, threadID);
  }
}

async function handleGroupCommand(api, event, args, isAdmin) {
  try {
    const { threadID, senderID } = event;
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
      return await api.sendMessage(reply, threadID);
    }
    const subCommand = args.shift();
    if (subCommand === 'on') {
      const groupName = args.join(' ');
      if (!groupName) {
        const reply = await formatMessage(api, event, "Sahi format use karo: /group on <group_name>");
        return await api.sendMessage(reply, threadID);
      }
      lockedGroups[threadID] = groupName;
      await api.setTitle(groupName, threadID);
      const reply = await formatMessage(api, event, `GROUP KA NAME LOCK HO GYA HAI AB TERI BHAN KI CHUT KA DAM LGA OR NAAM CHANGE KR BHADVE`);
      await api.sendMessage(reply, threadID);
    } else if (subCommand === 'off') {
        delete lockedGroups[threadID];
        const reply = await formatMessage(api, event, "Group name unlock ho gaya hai.");
        await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('Error in handleGroupCommand: ' + error.message, true);
    await api.sendMessage("Group name lock karne mein error aa gaya.", threadID);
  }
}

async function handleNicknameCommand(api, event, args, isAdmin) {
  try {
    const { threadID, senderID } = event;
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
      return await api.sendMessage(reply, threadID);
    }
    const subCommand = args.shift();
    if (subCommand === 'on') {
      const nickname = args.join(' ');
      if (!nickname) {
        const reply = await formatMessage(api, event, "Sahi format use karo: /nickname on <nickname>");
        return await api.sendMessage(reply, threadID);
      }
      lockedNicknames[threadID] = nickname;
      const threadInfo = await api.getThreadInfo(threadID);
      for (const pid of threadInfo.participantIDs) {
        if (pid !== adminID) {
          await api.changeNickname(nickname, threadID, pid);
        }
      }
      const reply = await formatMessage(api, event, `GROUP KA NICKNAME LOCK HO GYA HAI AB JHAT UKHAO`);
      await api.sendMessage(reply, threadID);
    } else if (subCommand === 'off') {
        delete lockedNicknames[threadID];
        const reply = await formatMessage(api, event, "Group ke sabhi nicknames unlock ho gaye hain.");
        await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('Error in handleNicknameCommand: ' + error.message, true);
    await api.sendMessage("Nickname lock karne mein error aa gaya.", threadID);
  }
}

async function handleBotNickCommand(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return api.sendMessage(reply, threadID);
  }
  const newNickname = args.join(' ');
  if (!newNickname) {
    const reply = await formatMessage(api, event, "Sahi format use karo: /botnick <nickname>");
    return api.sendMessage(reply, threadID);
  }
  botNickname = newNickname;
  const botID = api.getCurrentUserID();
  try {
    fs.writeFileSync('config.json', JSON.stringify({ botNickname: newNickname }, null, 2));
    await api.changeNickname(newNickname, threadID, botID);
    const reply = await formatMessage(api, event, `MERA NICKNAME AB ${newNickname} HO GAYA HAI BOSSS.`);
    await api.sendMessage(reply, threadID);
  } catch (e) {
    emitLog('Error setting bot nickname: ' + e.message, true);
    const reply = await formatMessage(api, event, 'Error: Bot ka nickname nahi badal paya.');
    await api.sendMessage(reply, threadID);
  }
}

async function handleThreadNameChange(api, event) {
  try {
    const { threadID, authorID } = event;
    const newTitle = event.logMessageData?.name;
    if (lockedGroups[threadID] && authorID !== adminID) {
      if (newTitle !== lockedGroups[threadID]) {
        await api.setTitle(lockedGroups[threadID], threadID);
        const userInfo = await api.getUserInfo(authorID);
        const authorName = userInfo[authorID]?.name || "User";
        
        await api.sendMessage({
          body: `GRP KA NAAM CHANGE KARNE SE PELE APNI BHAN KI CHUT LEKR AANA SAMJHA CHAL AB NIKAL`,
          mentions: [{ tag: authorName, id: authorID, fromIndex: 0 }]
        }, threadID);
      }
    }
  } catch (error) {
    emitLog('Error in handleThreadNameChange: ' + error.message, true);
  }
}

async function handleNicknameChange(api, event) {
  try {
    const { threadID, authorID, participantID, newNickname } = event;
    const botID = api.getCurrentUserID();

    if (participantID === botID && authorID !== adminID) {
      if (newNickname !== botNickname) {
        await api.changeNickname(botNickname, threadID, botID);
        await api.sendMessage(`KYA RE TAKLE BAAP KA NICKNAME CHANGE KREGA, TERI BHAN KI CHUT ME ETNA DAM NHI ${botNickname} CHAL NIKAL MC AB`, threadID);
      }
    }
    
    if (lockedNicknames[threadID] && authorID !== adminID) {
      if (newNickname !== lockedNicknames[threadID]) {
        await api.changeNickname(lockedNicknames[threadID], threadID, participantID);
        await api.sendMessage(`GROUP KA NICKNAME BDL RHA HAI AGAR FIRSE KOI CHANGE KIYA TO USKI BHAN KI CHUT ME AAHAN PAPA KA LODA JAYEGA`, threadID);
      }
    }
  } catch (error) {
    emitLog('Error in handleNicknameChange: ' + error.message, true);
  }
}

async function handleHelpCommand(api, event) {
  const { threadID, senderID } = event;
  const helpMessage = `
╔═══════════════════════╗
║      AAHAN H3R3 BOT      ║
║      COMMAND LIST       ║
╚═══════════════════════╝

▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
📚 INFORMATION COMMANDS
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
┣ ↠ ${prefix}help - All commands dikhaye
┣ ↠ ${prefix}tid - Group ID dikhaye
┗ ↠ ${prefix}uid <mention> - User ID dikhaye

▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
🔐 GROUP CONTROL & SECURITY
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
┣ ↠ ${prefix}group on <name> - Group name lock
┣ ↠ ${prefix}group off - Group name unlock
┣ ↠ ${prefix}nickname on <name> - Sabke nickname lock
┣ ↠ ${prefix}nickname off - Nickname unlock
┣ ↠ ${prefix}botnick <name> - Bot ka nickname set
┣ ↠ ${prefix}antiout on - Anti-out chalu
┗ ↠ ${prefix}antiout off - Anti-out band

▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
💥 ATTACK & RAID SYSTEM
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
┣ ↠ ${prefix}target on <file> <name> - Target attack
┣ ↠ ${prefix}target off - Target band
┣ ↠ ${prefix}hanger on - Hanger start
┣ ↠ ${prefix}hanger off - Hanger band
┣ ↠ ${prefix}addvirus - 4 virus add (silent)
┗ ↠ ${prefix}botout - Bot group se left

▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
🎯 AUTO-REPLY SYSTEM
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
┣ ↠ mkc, randi, chutiya
┣ ↠ teri maa chod dunga
┣ ↠ boxdika, bot
┗ ↠ Admin mention

╔═══════════════════════╗
║   POWERED BY          ║
║   AAHAN H3R3 BOT      ║
╚═══════════════════════╝
`;
  const formattedHelp = await formatMessage(api, event, helpMessage.trim());
  await api.sendMessage(formattedHelp, threadID);
}
