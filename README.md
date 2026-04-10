# 💣 MINES
### A Sleek, Provably Fair Web Game
**Play the Live Demo**
MINES is a high-stakes, browser-based game of risk and reward. Built with a focus on modern UI/UX and transparency, it utilizes cryptographic hashing to ensure every round is **provably fair**.
## 🕹️ The Experience
Players must navigate a 5x5 grid to find hidden gems while avoiding buried mines. Each gem found increases the payout multiplier. Cash out at any time, or risk it all for the ultimate jackpot.
 * **Dynamic Difficulty:** Adjust the mine count from 1 to 24 to scale your risk.
 * **Real-time Sync:** Powered by **Firebase Auth & Firestore**, your balance and history sync across all your devices.
 * **Provably Fair:** Uses HMAC (SHA-256) to derive mine positions, ensuring the house cannot manipulate the outcome mid-game.
 * **Mobile First:** Responsive CSS designed for desktop precision and mobile accessibility.
## 🛠️ Tech Stack
 * **Frontend:** HTML5, CSS3 (Custom Variables/Animations), Vanilla JavaScript (ES6+).
 * **Backend-as-a-Service:** Firebase Authentication & Cloud Firestore.
 * **Typography:** 'Bebas Neue' for high-impact headings and 'DM Mono' for a technical, data-driven feel.
 * **Security:** Cryptographic Web Crypto API for game seed generation.
## 🚀 Getting Started
To host your own version of this project:
 1. **Clone the Repository:**
   ```bash
   git clone https://github.com/kenster90/Mines-game.git
   
   ```
 2. **Configure Firebase:**
   * Create a project at the Firebase Console.
   * Enable **Email/Password Authentication**.
   * Create a **Firestore Database**.
   * Copy your config object into the firebaseConfig block in index.html.
 3. **Deploy:**
   Upload index.html to any static hosting provider (GitHub Pages, Netlify, Vercel).
## ⚖️ Provably Fair Logic
The game ensures transparency using a cryptographic commitment:
 1. A **Client Seed** is generated at the start of every game using crypto.getRandomValues.
 2. The mine positions are determined by hashing the seed with the cell indices using **HMAC-SHA256**.
 3. Because the seed is generated locally, the result is mathematically verifiable and cannot be altered by the server after the bet is placed.
> **Note:** This implementation uses integer-cent math to prevent the floating-point rounding errors common in many web-based gambling clones.
> 
## 📜 License
This project is licensed under the MIT License.
### 🔗 Quick Links
 * **Live Site:** [kenster90.github.io/Mines-game](kenster90.github.io/Mines-game)
 * **Report Bug:** GitHub Issues
*Developed with ❤️ by Kenster90*
