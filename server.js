import express from 'express';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { convertRawToWav, getAudioStats } from './audioUtils.js';

import dotenv from 'dotenv';
dotenv.config();

// Configuration
const config = {
  port: process.env.PORT || 3000,
  recordingsDir: process.env.RECORDINGS_DIR || './recordings',
  s3: {
    region: process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'your-audio-bucket-2',
    keyPrefix: process.env.S3_KEY_PREFIX || 'calls/'
  },
  apiKey: process.env.API_KEY || 'your-api-key-here', // Set this to your actual API key
  clientSecret: process.env.CLIENT_SECRET // Optional for signature verification
};

// Create recordings directory if it doesn't exist
if (!fs.existsSync(config.recordingsDir)) {
  fs.mkdirSync(config.recordingsDir, { recursive: true });
}

// Initialize the S3 client
const s3Client = new S3Client({ region: config.s3.region });

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Middleware for request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Basic request authentication middleware
function validateSignature(req) {
  // Skip validation if no client secret is configured
  if (!config.clientSecret) {
    return true;
  }

  try {
    const signature = req.headers['signature'];
    const signatureInput = req.headers['signature-input'];
    
    if (!signature || !signatureInput) {
      console.log('Missing signature headers');
      return false;
    }
    
    // Simple presence check for demo purposes
    return true;
  } catch (error) {
    console.error('Error validating signature:', error);
    return false;
  }
}

// Create WebSocket server
const wss = new WebSocketServer({ 
  server,
  // Handle the WebSocket upgrade request to perform authentication
  handshakeTimeout: 60000,
  verifyClient: (info, callback) => {
    const apiKey = info.req.headers['X-API-KEY'] || info.req.headers['x-api-key'];
    const sessionId = info.req.headers['Audiohook-Session-Id'] || info.req.headers['audiohook-session-id'];
    const organizationId = info.req.headers['Audiohook-Organization-Id'] || info.req.headers['audiohook-organization-id'];
    
    // Verify API key matches
    if (config.apiKey !== apiKey) {
      console.log('Authentication failed: Invalid API key');
      callback(false, 401, 'Unauthorized');
      return;
    }
    
    // Validate request signature if client secret is configured
    if (!validateSignature(info.req)) {
      console.log('Authentication failed: Invalid signature');
      callback(false, 401, 'Unauthorized');
      return;
    }
    
    // Check required headers
    if (!sessionId || !organizationId) {
      console.log('Missing required AudioHook headers');
      callback(false, 400, 'Bad Request');
      return;
    }
    
    callback(true);
  }
});

// Map to track active sessions
const activeSessions = new Map();

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection established');
  
  // Extract headers for authentication and context
  const organizationId = req.headers['audiohook-organization-id'];
  const correlationId = req.headers['audiohook-correlation-id'];
  const sessionId = req.headers['audiohook-session-id'];
  
  console.log(`New connection: org=${organizationId}, corr=${correlationId}, session=${sessionId}`);
  
  // Initialize session state
  const sessionData = {
    id: sessionId,
    organizationId,
    correlationId,
    serverSeq: 0,  // Server sequence number
    clientSeq: 0,  // Track last client sequence
    position: 'PT0S',  // Current position in the audio stream
    audioFormat: null,  // Will be populated during open transaction
    rawFilename: null,
    wavFilename: null,
    fileStream: null,
    state: 'connecting',  // Session state
    isPaused: false,
    startTime: new Date(),
    bytesReceived: 0,
    discardedSegments: [],
    pauseSegments: []
  };
  
  activeSessions.set(sessionId, sessionData);
  
  // Handle WebSocket messages
  ws.on('message', async (message, isBinary) => {
    try {
      // If it's a non-binary message (text), handle it as a control message
      if (!isBinary) {
        console.log('Received text message');
        
        // Parse the text message as JSON
        let msgData;
        try {
          const msgString = message.toString('utf8');
          console.log('---------------------');
          console.log(msgString);
          msgData = JSON.parse(msgString);
          console.log(msgData);
        } catch (jsonErr) {
          console.error('Failed to parse text message as JSON:', jsonErr);
          return;
        }
        
        // Update session tracking
        sessionData.clientSeq = msgData.seq;
        
        // Handle different message types
        switch (msgData.type) {
          case 'open':
            console.log('Processing open message');
            await handleOpenMessage(ws, sessionData, msgData);
            break;
          case 'close':
            await handleCloseMessage(ws, sessionData, msgData);
            break;
          case 'paused':
            handlePausedMessage(sessionData, msgData);
            break;
          case 'ping':
            handlePingMessage(ws, sessionData, msgData);
            break;
          case 'discarded':
            handleDiscardedMessage(sessionData, msgData);
            break;
          case 'update':
            handleUpdateMessage(ws, sessionData, msgData);
            break;
          case 'resumed':
            handleResumedMessage(sessionData, msgData);
            break;
          case 'error':
            console.log(`Client error: ${msgData.parameters.code} - ${msgData.parameters.message}`);
            break;
          default:
            console.log(`Unhandled message type: ${msgData.type}`);
        }
      }
      // If it's a binary message, try to interpret it
      else {
        // Try to convert to string and see if it's a JSON message
        try {
          const messageString = message.toString('utf8');
          
          // Check if it looks like JSON
          if (messageString.startsWith('{') && messageString.includes('"type"')) {
            console.log('Received JSON message in binary frame');
            console.log('---------------------');
            console.log(messageString);
            
            // Parse as JSON
            const msgData = JSON.parse(messageString);
            console.log(msgData);
            
            // Update session tracking
            sessionData.clientSeq = msgData.seq;
            
            // Handle different message types
            switch (msgData.type) {
              case 'open':
                console.log('Processing open message from binary frame');
                await handleOpenMessage(ws, sessionData, msgData);
                break;
              case 'close':
                await handleCloseMessage(ws, sessionData, msgData);
                break;
              case 'paused':
                handlePausedMessage(sessionData, msgData);
                break;
              case 'ping':
                handlePingMessage(ws, sessionData, msgData);
                break;
              case 'discarded':
                handleDiscardedMessage(sessionData, msgData);
                break;
              case 'update':
                handleUpdateMessage(ws, sessionData, msgData);
                break;
              case 'resumed':
                handleResumedMessage(sessionData, msgData);
                break;
              case 'error':
                console.log(`Client error: ${msgData.parameters.code} - ${msgData.parameters.message}`);
                break;
              default:
                console.log(`Unhandled message type: ${msgData.type}`);
            }
          } 
          // It's not a JSON message, so it must be audio data
          else {
            console.log(`Received binary audio data: ${message.length} bytes`);
            
            if (sessionData.state === 'open') {
              handleAudioData(sessionData, message);
            } else {
              console.log('Received audio data but session not open yet, ignoring');
            }
          }
        } catch (err) {
          // If we get here, it's probably binary audio data
          console.log(`Received binary audio data: ${message.length} bytes`);
          
          if (sessionData.state === 'open') {
            handleAudioData(sessionData, message);
          } else {
            console.log('Received audio data but session not open yet, ignoring');
          }
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  // Handle WebSocket close
  ws.on('close', async (code, reason) => {
    console.log(`WebSocket closed for session ${sessionId}: code=${code}, reason=${reason || 'none'}`);
    await cleanupSession(sessionData);
    activeSessions.delete(sessionId);
  });
  
  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for session ${sessionId}:`, error);
  });
});

// Handle open message - negotiate media format
async function handleOpenMessage(ws, sessionData, message) {
  console.log('Handling open message with details:');
  console.log(JSON.stringify(message, null, 2));
  
  try {
    // Check if this is a connection probe
    const isConnectionProbe = message.parameters.conversationId === '00000000-0000-0000-0000-000000000000' ||
      (message.parameters.participant && message.parameters.participant.id === '00000000-0000-0000-0000-000000000000');
    
    if (isConnectionProbe) {
      console.log('Connection probe detected - this is a test connection, not a real call');
      sessionData.isConnectionProbe = true;
    }
    
    // Extract media parameters from the open message
    const mediaOptions = message.parameters.media || [];
    console.log(`Media options offered: ${JSON.stringify(mediaOptions)}`);
    
    // Select the first media format (usually stereo)
    let selectedMedia = null;
    if (mediaOptions.length > 0) {
      // Prefer stereo if available
      for (const media of mediaOptions) {
        if (media.type === 'audio' && 
            media.format === 'PCMU' && 
            media.channels &&
            media.channels.length === 2) {
          selectedMedia = media;
          console.log('Selected stereo media format');
          break;
        }
      }
      
      // Fall back to first option if no stereo found
      if (!selectedMedia) {
        selectedMedia = mediaOptions[0];
        console.log('Selected first available media format');
      }
    } else {
      console.log('No media options provided');
      sendDisconnectMessage(ws, sessionData, 'error', 'No media options provided');
      return;
    }
    
    // CRITICAL: Send opened response immediately
    const openedResponse = {
      version: '2',
      type: 'opened',
      seq: ++sessionData.serverSeq,
      clientseq: message.seq,
      id: message.id,
      parameters: {
        startPaused: false,
        media: [selectedMedia]
      }
    };
    
    // Send the response
    const responseStr = JSON.stringify(openedResponse);
    console.log(`Sending opened response: ${responseStr}`);
    ws.send(responseStr);
    console.log('Opened response sent successfully');
    
    // Update session state AFTER sending response
    sessionData.state = 'open';
    sessionData.audioFormat = selectedMedia;
    sessionData.position = message.position;
    
    // Save important information from the open message
    sessionData.organizationId = message.parameters.organizationId;
    sessionData.conversationId = message.parameters.conversationId;
    sessionData.participant = message.parameters.participant;
    sessionData.language = message.parameters.language || 'unknown';
    
    // If this is just a connection probe, don't create a recording file
    if (sessionData.isConnectionProbe) {
      console.log('Skipping file creation for connection probe');
      return;
    }
    
    // Create a unique filename for the recording
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const rawFilename = `${timestamp}_${sessionData.conversationId}_${sessionData.participant.id}.raw`;
    const rawFilePath = path.join(config.recordingsDir, rawFilename);
    
    console.log(`Creating recording file: ${rawFilePath}`);
    
    // Create a write stream for the recording
    const fileStream = fs.createWriteStream(rawFilePath);
    
    // Set up error handler for the file stream
    fileStream.on('error', (err) => {
      console.error(`File stream error: ${err.message}`);
    });
    
    // Update session data with recording info
    sessionData.rawFilename = rawFilename;
    sessionData.rawFilePath = rawFilePath;
    sessionData.fileStream = fileStream;
    sessionData.channels = selectedMedia.channels;
    sessionData.sampleRate = selectedMedia.rate;
    
    console.log('Open transaction completed successfully');
  } catch (error) {
    console.error('Error in handleOpenMessage:', error);
    sendErrorMessage(ws, sessionData, 500, 'Internal server error');
  }
}

// Handle close message - finalize recording and upload to S3
// Handle close message - finalize recording and upload to S3
async function handleCloseMessage(ws, sessionData, message) {
  console.log('Handling close message');
  
  // Update session state
  sessionData.state = 'closing';
  sessionData.position = message.position;
  sessionData.endTime = new Date();
  sessionData.callDuration = (sessionData.endTime - sessionData.startTime) / 1000;
  
  try {
    // Close the file stream if it exists
    if (sessionData.fileStream) {
      console.log('Closing file stream');
      await new Promise((resolve, reject) => {
        sessionData.fileStream.end(err => {
          if (err) {
            console.error(`Error closing file stream: ${err.message}`);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
    
    // Skip audio conversion and S3 upload for connection probes
    if (!sessionData.isConnectionProbe && sessionData.rawFilePath && fs.existsSync(sessionData.rawFilePath)) {
      try {
        const wavFilename = sessionData.rawFilename.replace('.raw', '.wav');
        const wavFilePath = path.join(config.recordingsDir, wavFilename);
        
        console.log(`Converting raw audio to WAV: ${wavFilePath}`);
        
        await convertRawToWav(
          sessionData.rawFilePath, 
          wavFilePath, 
          sessionData.channels.length, 
          sessionData.sampleRate,
          sessionData.channels
        );
        
        sessionData.wavFilename = wavFilename;
        sessionData.wavFilePath = wavFilePath;
        
        // Get audio statistics
        const audioStats = await getAudioStats(wavFilePath);
        sessionData.audioStats = audioStats;
        
        console.log(`Successfully converted audio with channels: ${sessionData.channels.join(', ')}`);
      } catch (error) {
        console.error('Error converting audio:', error);
      }
    }
    
    // Upload the recording to S3 if enabled and not a connection probe
    if (!sessionData.isConnectionProbe && s3Client && 
        sessionData.rawFilePath && fs.existsSync(sessionData.rawFilePath)) {
      try {
        await uploadToS3(sessionData);
      } catch (s3Err) {
        console.error('S3 upload failed:', s3Err);
      }
    }
    
    // Send closed response
    sendClosedResponse(ws, sessionData, message);
  } catch (error) {
    console.error('Error handling close message:', error);
    sendErrorMessage(ws, sessionData, 500, 'Internal Error');
  }
}

// Handle paused message
function handlePausedMessage(sessionData, message) {
  console.log('Handling paused message');
  sessionData.isPaused = true;
  sessionData.position = message.position;
  
  // Record pause start time to track pause duration
  sessionData.currentPauseStart = message.position;
}

// Handle resumed message
function handleResumedMessage(sessionData, message) {
  console.log('Handling resumed message');
  sessionData.isPaused = false;
  sessionData.position = message.position;
  
  // Record pause segment if we have a start time
  if (sessionData.currentPauseStart) {
    const pauseSegment = {
      start: sessionData.currentPauseStart,
      end: message.position,
      duration: message.parameters.discarded
    };
    
    sessionData.pauseSegments.push(pauseSegment);
    sessionData.currentPauseStart = null;
  }
}

// Handle ping message
function handlePingMessage(ws, sessionData, message) {
  // Respond with pong message
  sendPongResponse(ws, sessionData, message);
}

// Handle discarded message
function handleDiscardedMessage(sessionData, message) {
  console.log('Handling discarded message');
  // Update position
  sessionData.position = message.position;
  
  // Record discarded segment
  const discardedSegment = {
    start: message.parameters.start,
    duration: message.parameters.discarded
  };
  
  sessionData.discardedSegments.push(discardedSegment);
  
  // Log discarded audio for debugging
  console.log(`Discarded audio: start=${message.parameters.start}, discarded=${message.parameters.discarded}`);
}

// Handle update message
function handleUpdateMessage(ws, sessionData, message) {
  console.log('Handling update message');
  
  // Update language if provided
  if (message.parameters.language) {
    sessionData.language = message.parameters.language;
    console.log(`Updated language to: ${sessionData.language}`);
  }
}

// Handle audio data frames
// Update handleAudioData function
function handleAudioData(sessionData, audioBuffer) {
  // Skip if session is not open or is paused or is a connection probe
  if (sessionData.state !== 'open' || sessionData.isPaused || sessionData.isConnectionProbe) {
    console.log(`Cannot process audio: state=${sessionData.state}, isPaused=${sessionData.isPaused}, isProbe=${sessionData.isConnectionProbe || false}`);
    return;
  }
  
  // Track bytes received
  const bytesCount = audioBuffer.length;
  sessionData.bytesReceived += bytesCount;
  
  // Log audio frame less frequently to avoid flooding logs
  if (sessionData.bytesReceived % 50000 < bytesCount) {
    console.log(`Processed ${Math.floor(sessionData.bytesReceived/1024)}KB of audio data so far`);
  }
  
  // Write the audio data to the file if we have a fileStream
  if (sessionData.fileStream) {
    try {
      sessionData.fileStream.write(audioBuffer);
    } catch (error) {
      console.error(`Error writing audio data to file: ${error.message}`);
    }
  } else {
    console.warn('No fileStream available for writing audio data');
  }
}

// Upload the recording to S3
async function uploadToS3(sessionData) {
  console.log(`Uploading recording ${sessionData.rawFilename} to S3`);

  const filePath =  `${config.s3.keyPrefix}${sessionData.rawFilename.replace('.raw', '')}/audio/`
  
  try {
    // Upload raw file
    const rawFileData = fs.readFileSync(sessionData.rawFilePath);
    const s3RawKey = `${filePath}${sessionData.rawFilename}`;
    
    // Set up metadata
    const metadata = {
      'conversation-id': sessionData.conversationId,
      'participant-id': sessionData.participant.id,
      'ani': sessionData.participant.ani || 'unknown',
      'dnis': sessionData.participant.dnis || 'unknown',
      'audio-format': sessionData.audioFormat.format,
      'sample-rate': sessionData.audioFormat.rate.toString(),
      'channels': sessionData.audioFormat.channels.join(','),
      'language': sessionData.language,
      'duration-seconds': sessionData.callDuration ? sessionData.callDuration.toString() : 'unknown',
      'start-time': sessionData.startTime.toISOString(),
      'bytes': sessionData.bytesReceived.toString()
    };
    
    // Upload raw file to S3
    const rawCommand = new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3RawKey,
      Body: rawFileData,
      ContentType: 'audio/basic', // PCMU raw audio
      Metadata: metadata
    });
    
    await s3Client.send(rawCommand);
    console.log(`Successfully uploaded raw recording to S3: ${s3RawKey}`);
    
    // Upload WAV file if it exists
    if (sessionData.wavFilePath && fs.existsSync(sessionData.wavFilePath)) {
      const wavFileData = fs.readFileSync(sessionData.wavFilePath);

      const s3WavKey = `${filePath}${sessionData.wavFilename}`;
      
      const wavCommand = new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: s3WavKey,
        Body: wavFileData,
        ContentType: 'audio/wav',
        Metadata: {
          ...metadata,
          'converted': 'true',
          'original-file': sessionData.rawFilename
        }
      });
      
      await s3Client.send(wavCommand);
      console.log(`Successfully uploaded WAV recording to S3: ${s3WavKey}`);
    }
    
    return true;
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
}

// Clean up session resources
async function cleanupSession(sessionData) {
  console.log(`Cleaning up session ${sessionData.id}`);
  
  // Close file stream if it exists
  if (sessionData.fileStream) {
    try {
      await new Promise((resolve) => {
        sessionData.fileStream.end(() => resolve());
      });
      sessionData.fileStream = null;
    } catch (error) {
      console.error(`Error closing file stream: ${error.message}`);
    }
  }
  
  // Delete the local files after successful S3 upload (optional)
  try {
    if (sessionData.rawFilePath && fs.existsSync(sessionData.rawFilePath)) {
      fs.unlinkSync(sessionData.rawFilePath);
      console.log(`Deleted local raw recording file: ${sessionData.rawFilePath}`);
    }
    
    if (sessionData.wavFilePath && fs.existsSync(sessionData.wavFilePath)) {
      fs.unlinkSync(sessionData.wavFilePath);
      console.log(`Deleted local WAV recording file: ${sessionData.wavFilePath}`);
    }
  } catch (error) {
    console.error(`Error deleting local recording files: ${error.message}`);
  }
}

// Send closed response
function sendClosedResponse(ws, sessionData, message) {
  const response = {
    version: '2',
    type: 'closed',
    seq: ++sessionData.serverSeq,
    clientseq: message.seq,
    id: sessionData.id,
    parameters: {}
  };
  
  ws.send(JSON.stringify(response));
  console.log(`Sent closed response, seq=${response.seq}`);
}

// Send pong response
function sendPongResponse(ws, sessionData, message) {
  const response = {
    version: '2',
    type: 'pong',
    seq: ++sessionData.serverSeq,
    clientseq: message.seq,
    id: sessionData.id,
    parameters: {}
  };
  
  ws.send(JSON.stringify(response));
}

// Send disconnect message
function sendDisconnectMessage(ws, sessionData, reason, info) {
  const response = {
    version: '2',
    type: 'disconnect',
    seq: ++sessionData.serverSeq,
    clientseq: sessionData.clientSeq,
    id: sessionData.id,
    parameters: {
      reason: reason,
      info: info
    }
  };
  
  ws.send(JSON.stringify(response));
  console.log(`Sent disconnect message, reason=${reason}, seq=${response.seq}`);
}

// Send error message
function sendErrorMessage(ws, sessionData, code, message) {
  const response = {
    version: '2',
    type: 'error',
    seq: ++sessionData.serverSeq,
    clientseq: sessionData.clientSeq,
    id: sessionData.id,
    parameters: {
      code: code,
      message: message
    }
  };
  
  ws.send(JSON.stringify(response));
  console.log(`Sent error message, code=${code}, seq=${response.seq}`);
}

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeSessions: activeSessions.size,
    uptime: process.uptime()
  });
});

// Statistics endpoint
app.get('/stats', (req, res) => {
  // Convert the activeSessions Map to an array of session details
  const sessions = Array.from(activeSessions.values()).map(session => ({
    id: session.id,
    conversationId: session.conversationId,
    startTime: session.startTime,
    bytesReceived: session.bytesReceived,
    state: session.state,
    isPaused: session.isPaused,
    language: session.language
  }));
  
  res.status(200).json({
    totalSessions: activeSessions.size,
    sessions
  });
});

// Start the server
server.listen(config.port, () => {
  console.log(`Genesys AudioHook Recorder server listening on port ${config.port}`);
});