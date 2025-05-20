# Genesys AudioHook Recorder

This Node.js application implements a WebSocket Express server that follows the Genesys AudioHook protocol to receive call audio, format it to `wav`, and upload it to S3.

## Features

- Full implementation of the Genesys AudioHook WebSocket protocol
- Records incoming audio data from Genesys calls
- Handles all protocol events (open, close, pause, ping, etc.)
- Uploads recordings to Amazon S3 upon call completion
- API key authentication for security

## Prerequisites

- Node.js 14.x or higher
- AWS account with S3 bucket access
- Genesys Cloud account with AudioHook integration

## Installation

1. Clone this repository
2. Install dependencies:

```bash
npm install
```

3. Configure environment variables (see Configuration section)

## Dependencies

Add these to your package.json:

```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.360.0",
    "dotenv": "^16.5.0",
    "express": "^4.18.2",
    "ws": "^8.13.0"
  }
}
```

## Configuration

The application can be configured using environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 3000 |
| RECORDINGS_DIR | Directory to store temporary recordings | ./recordings |
| AWS_REGION | AWS region for S3 | us-east-1 |
| S3_BUCKET | S3 bucket name | audiohook-recordings |
| S3_KEY_PREFIX | Prefix for S3 object keys | calls/ |
| API_KEY | API key for authentication | your-api-key-here |

Set environment variables in `.env` file:

```bash
PORT=3000
API_KEY=your-api-key-here
AWS_REGION=us-east-1
S3_BUCKET=your-bucket-name
S3_KEY_PREFIX=calls/
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
CONVERT_AUDIO=true
```

## Running the Application

```bash
# Start the server
npm start
```

## Integrating with Genesys Cloud

1. In Genesys Cloud, create a new AudioHook integration
2. Set the WebSocket URI to the deployed application URL (e.g., `wss://your-domain.com`)
3. Configure the API key to match the `API_KEY` variable in your `env`
4. Associate the AudioHook integration with your call flows

## Troubleshooting

- Check the server logs for detailed information about connection issues
- Verify that your API key matches between Genesys Cloud and your application
- Ensure your AWS credentials have proper permissions for the S3 bucket
- The `/health` endpoint can be used to check if the server is running
