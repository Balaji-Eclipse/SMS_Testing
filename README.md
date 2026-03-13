# 📱 Twilio SMS Messenger

A modern, real-time SMS chat application built with Node.js and Twilio API. Send, receive, schedule, and manage SMS conversations with a beautiful dark-themed web interface.

## ✨ Features

### 📨 Core Messaging
- **Send SMS** - Instantly send text messages to any contact
- **Receive SMS** - Auto-refresh to continuously check for incoming messages
- **Message History** - Load and view full conversation history from Twilio
- **Auto-Refresh** - Configurable polling intervals (10s, 30s, 1m, 5m) for real-time updates

### 💬 Conversation Management
- **Contact List** - Manage multiple conversations in the sidebar
- **Search & Filter** - Quickly find contacts by name or number
- **Message Groups** - Organize messages by date and sender direction
- **Live Status** - Connection indicator shows when server is online

### ✏️ Advanced Features
- **Schedule Messages** - Set SMS to send at a specific future time
- **Quick Replies** - Pre-configured message templates for fast responses
- **Message Status** - Track delivery status (Sending → Sent → Delivered → Failed)
- **Redact Messages** - Clear sensitive message content from history
- **Delete Messages** - Remove individual or bulk messages

### 📊 Analytics & Logs
- **Message Statistics** - Total messages, cost tracking, and scheduled count
- **API Log** - Real-time log of all API interactions
- **Account Dashboard** - View Twilio account information and limits
- **Error Reporting** - Clear error messages for troubleshooting

### 🎨 User Experience
- **Responsive Design** - Works on desktop, tablet, and mobile
- **Dark Theme** - Nova theme with gold accents (eye-friendly)
- **SMS Segment Counter** - Shows character count and multi-part message info
- **Toast Notifications** - Real-time feedback for all actions
- **Smooth Animations** - Polished transitions and visual feedback

### 🔧 Performance & Reliability
- **Message Ordering Fix** ⭐ - Corrected timestamp handling for proper chronological order
- **Deduplication** - Prevents duplicate messages in conversation history
- **Connection Pooling** - Efficient Twilio API usage
- **Keep-Alive** - Maintains server uptime on Render free tier

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Twilio Account with API credentials
- Modern web browser

### Installation

1. **Clone the repository**
```bash
git clone <repo-url>
cd SMS_Testing
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**
Create a `.env` file in the root directory:
```env
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=your_twilio_number
PORT=3000
NODE_ENV=development
```

Get your credentials from [Twilio Console](https://console.twilio.com)

4. **Start the server**
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

5. **Open browser**
Navigate to `http://localhost:3000`

## 📖 Usage Guide

### Sending a Message
1. Click **"+ New Conversation"** or select an existing contact
2. Type your message in the input box
3. Press `Enter` or click the send button (⬆️)
4. Message status updates in real-time

### Managing Contacts
- **Add Contact** - Tap "New Conversation" and enter phone number
- **Search** - Use the search bar to filter contacts
- **Delete History** - Click the trash icon in the header to clear chat
- **View Stats** - Click stats in sidebar to see message metrics

### Auto-Refresh Settings
- **Toggle ON/OFF** - Click the toggle button in sidebar header
- **Set Interval** - Choose 10s, 30s, 1m, or 5m polling frequency
- **Progress Ring** - Visual countdown until next refresh

### Scheduling Messages
1. Click the **⏰ Schedule** button in conversation header
2. Enter message and select future date/time
3. Scheduled messages appear in a bar above the input
4. Messages auto-send at scheduled time

### Message Context Menu
Right-click (or long-press on mobile) any message bubble for options:
- **Reply** - Quote the message in your response
- **Redact** - Clear the message content
- **Delete** - Remove the message entirely

## 🔒 Security Notes

- ⚠️ Never commit `.env` file to version control
- Always use HTTPS in production
- API credentials are server-side only (not exposed to client)
- Consider rate limiting for public deployments
- Message history is stored only on Twilio's servers

## 📝 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/config` | Get Twilio phone number |
| POST | `/send` | Send SMS message |
| GET | `/history` | Load conversation history |
| GET | `/status/:sid` | Check message delivery status |
| POST | `/redact/:sid` | Clear message content |
| DELETE | `/messages/:sid` | Delete a single message |
| DELETE | `/messages/contact/:number` | Clear all messages with contact |
| DELETE | `/messages/clearall` | Clear all messages in account |
| POST | `/schedule` | Schedule message for future |
| GET | `/schedule` | List scheduled messages |

## 🐛 Recent Improvements (v1.0.1)

### Message Ordering Fix ⭐
**Fixed critical bug where received and sent messages appeared out of order**

- ✅ New `sortMessages()` helper function for consistent chronological sorting
- ✅ Unified timestamp handling across all message operations
- ✅ Proper message grouping by sender direction (in/out)
- ✅ Corrected timestamp extraction from Twilio API responses
- ✅ Fixed auto-refresh message integration

### Other Improvements
- Better error handling and user feedback
- Improved code organization and comments
- More efficient DOM rendering
- Enhanced mobile responsiveness

## 📂 Project Structure

```
SMS_Testing/
├── server.js              # Express backend with Twilio integration
├── public/
│   └── index.html         # Complete frontend (HTML/CSS/JS)
├── package.json           # Dependencies and scripts
├── .env                   # Environment variables (not in repo)
└── README.md              # This file
```

## 🛠️ Development

### Code Style
- Minified frontend for production efficiency
- Comment-heavy backend for maintainability
- Consistent error handling and logging

### Adding Features
1. Backend logic goes in `server.js`
2. Frontend UI/logic in `public/index.html`
3. Add new routes following existing patterns
4. Update API documentation in this README

### Debugging
- Check browser console for client errors
- Check server logs (Node terminal) for API errors
- Use the built-in **API Log** panel (click 📋 button)
- Enable `NODE_ENV=development` for verbose logging

## 📦 Dependencies

- **express** - Web server framework
- **twilio** - SMS API client
- **dotenv** - Environment variable management
- **node-fetch** - HTTP requests (keep-alive)
- **nodemon** (dev) - Auto-reload during development

## 🌐 Deployment

### Render (Recommended for Free Tier)
1. Push to GitHub
2. Connect Render project to repository
3. Add environment variables in Render dashboard
4. Trigger deploy
5. Server maintains uptime with built-in keep-alive

### Heroku / Railway / Other
Similar process - set environment variables and deploy

## 📞 Troubleshooting

| Issue | Solution |
|-------|----------|
| "Server offline" message | Run `npm start` and check terminal for errors |
| Messages not updating | Check Twilio credentials in `.env` |
| Messages out of order | Fixed in v1.0.1 - update to latest version |
| Cannot send message | Verify phone number format (E.164: +1234567890) |
| High API costs | Reduce auto-refresh interval or disable auto-refresh |

## 📄 License

MIT License - feel free to use and modify

## 🤝 Contributing

Contributions welcome! Please follow existing code style and add documentation for new features.

## 📧 Support

For Twilio API issues: [Twilio Docs](https://www.twilio.com/docs)
For application bugs: Check the API Log panel for detailed error messages

---

**Built with ❤️ using Node.js, Express, and Twilio**