# Publishing SentinelDrive OS to a new GitHub repository

1. On GitHub, create a new repository named `sentineldrive-os` under your account. Set visibility to **Private** if you want it visible only to you.
2. Do not initialise it with a README, `.gitignore` or license.
3. Extract this project ZIP. Open a terminal in the extracted `SentinelDrive_OS` folder.
4. Run the following commands in PowerShell or Git Bash:

```bash
git init -b main
git add .
git status
git commit -m "Initial release: SentinelDrive OS 3.0.5 with Vercel and Render deployment"
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/sentineldrive-os.git
git push -u origin main
```

Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username.

If Git reports that `main` already exists, continue with `git add .`. If Git asks for an identity, configure it once:

```bash
git config --global user.name "Your Name"
git config --global user.email "your-github-noreply-email@example.com"
```

Use Git Credential Manager or GitHub's browser-based sign-in when Git requests authentication. Never put a personal access token directly in the remote URL or commit it to a file.

The `.gitignore` excludes the local virtual environment, SQLite database, logs, cache directories, `.env` files and generated exports. Keep those excluded when publishing.
