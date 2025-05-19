import { execSync } from 'child_process';

/**
 * Convert raw audio (PCMU/G.711 μ-law) to WAV format
 * @param {string} inputPath Path to raw audio file
 * @param {string} outputPath Path to output WAV file
 * @param {number} channels Number of audio channels (1 for mono, 2 for stereo)
 * @param {number} sampleRate Sample rate in Hz (typically 8000 for PCMU)
 * @param {Array<string>} channelTypes Optional array of channel types (e.g. ['external', 'internal'])
 * @returns {Promise<void>}
 */
export const convertRawToWav = async (inputPath, outputPath, channels, sampleRate, channelTypes = []) => {
  return new Promise((resolve, reject) => {
    try {
      console.log(`Converting raw audio to WAV: ${outputPath}`);
      
      // Build channel labels for metadata if available
      let channelMapping = '';
      if (channelTypes && channelTypes.length > 0) {
        for (let i = 0; i < channelTypes.length; i++) {
          if (i > 0) channelMapping += ' / ';
          channelMapping += channelTypes[i];
        }
      }
      
      // Use ffmpeg to convert raw audio to WAV
      // Note: Changed -channels to -ac for FFmpeg compatibility
      const command = `ffmpeg -f mulaw -ar ${sampleRate} -ac ${channels} -i "${inputPath}" -c:a pcm_s16le "${outputPath}"`;
      
      execSync(command);
      
      // Add channel metadata if available
      if (channelMapping) {
        // This would require additional code to add metadata to the WAV file
        // For now, we'll just log the channel information
        console.log(`Audio channels: ${channelMapping}`);
      }
      
      resolve();
    } catch (error) {
      console.error('Error converting audio:', error);
      reject(error);
    }
  });
}

/**
 * Get audio statistics like duration, peak amplitude, etc.
 * @param {string} filePath Path to WAV file
 * @returns {Promise<object>} Audio statistics
 */
export const getAudioStats = async (filePath) => {
  return new Promise((resolve, reject) => {
    try {
      // Use ffprobe to get audio stats
      const command = `ffprobe -v error -show_entries format=duration -of json "${filePath}"`;
      const output = execSync(command).toString();
      const data = JSON.parse(output);
      
      resolve({
        duration: parseFloat(data.format.duration),
        channels: 0,  // We'd need additional ffprobe commands to get channel count
        // Add more stats as needed
      });
    } catch (error) {
      console.error('Error getting audio stats:', error);
      reject(error);
    }
  });
}
