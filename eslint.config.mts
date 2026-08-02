import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'eslint.config.mts',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts", "**/*.tsx"],
		rules: {
			"no-undef": "off", // TypeScript handles undefined-variable detection
		},
	},
	{
		// Mirror the type-aware rules the community-directory review bot
		// layers on top of the plugin's recommended config. Scoped to src/ —
		// the bot only reviews plugin source, and the config file itself is
		// checked without full project type information.
		files: ["src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
		},
	},
	{
		files: ["**/en.ts", "**/en.js"],
		rules: {
			"obsidianmd/ui/sentence-case-locale-module": ["error", {
				brands: [
					// Defaults
					"iOS", "iPadOS", "macOS", "Windows", "Android", "Linux",
					"Obsidian", "Obsidian Sync", "Obsidian Publish",
					"Google Drive", "Dropbox", "OneDrive", "iCloud Drive",
					"YouTube", "Slack", "Discord", "Telegram", "WhatsApp", "Twitter", "X",
					"Readwise", "Zotero", "Excalidraw", "Mermaid",
					"Markdown", "LaTeX", "JavaScript", "TypeScript", "Node.js",
					"npm", "pnpm", "Yarn", "Git", "GitHub", "GitLab",
					"Notion", "Evernote", "Roam Research", "Logseq", "Anki", "Reddit",
					"VS Code", "Visual Studio Code", "IntelliJ IDEA", "WebStorm", "PyCharm",
					// Project-specific
					"Garmin", "Garmin Connect", "Garmin Health Sync", "Dataview", "China",
				],
				acronyms: [
					// Defaults
					"API", "HTTP", "HTTPS", "URL", "DNS", "TCP", "IP", "SSH", "TLS", "SSL",
					"FTP", "SFTP", "SMTP", "JSON", "XML", "HTML", "CSS", "PDF", "CSV", "YAML",
					"SQL", "PNG", "JPG", "JPEG", "GIF", "SVG", "2FA", "MFA", "OAuth", "JWT",
					"LDAP", "SAML", "SDK", "IDE", "CLI", "GUI", "CRUD", "REST", "SOAP",
					"CPU", "GPU", "RAM", "SSD", "USB", "UI", "OK", "RSS", "S3", "WebDAV",
					"ID", "UUID", "GUID", "SHA", "MD5", "ASCII", "UTF-8", "UTF-16",
					"DOM", "CDN", "FAQ", "AI", "ML",
					// Project-specific
					"GPS", "REM", "HRV", "SpO2",
					"ST", // Garmin CAS service ticket prefix (ST-…), manual-login UI
				],
				ignoreRegex: ["garmin\\.(com|cn)"],
			}],
		},
	},
	{
		// The config file is linted via allowDefaultProject without full type
		// information, so type-aware rules produce false "error typed" hits.
		files: ["eslint.config.mts"],
		rules: {
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
		},
	},
	globalIgnores([
		".claude", // worktrees of parallel sessions carry their own checkouts
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"tools", // Dev-Referenz-Skripte (Node), kein Plugin-Source; tsc deckt via include nur src/ ab
	]),
);
