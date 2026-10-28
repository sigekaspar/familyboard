// ============ KONFIGURATION ============
// Bei jeder Änderung an der App diese Version hochzählen – darüber erkennen offene Apps,
// dass es eine neue Version gibt (Banner "Neu laden").
const APP_VERSION = '2026-10-27-01';

const CLIENT_ID = '482edec5-c2bf-49db-85bf-cbd5ebfa1989';
const REDIRECT_URI = 'https://sigekaspar.github.io/familyboard/';
const SCOPES = ['Files.ReadWrite', 'offline_access', 'User.Read'];
const GRAPH = 'https://graph.microsoft.com/v1.0';
const CONTAINER_NAME = 'Boards';
const ATTACH_SUBFOLDER = 'anhaenge';
const ORDER_FILE = '_order.json';
const BOARDS_META_FILE = '_boards_meta.json';
const BACKUP_FOLDER = '_backups';
const ARCHIVE_FOLDER = '_archive';
const IMPORTANT_INDEX_FILE = '_important.json';
const IMPORTANT_BOARD_NAME = 'Wichtig';
const BACKUP_RETENTION_DAYS = 30;
const SAFETY_BACKUP_PREFIX = 'vor-wiederherstellung_';
const SAFETY_BACKUP_KEEP = 5;
const IMAGE_MAX_EDGE = 2000;          // Fotos werden vor dem Upload auf max. 2000 px verkleinert
const IMAGE_SHRINK_MIN_BYTES = 800 * 1024; // ...aber nur, wenn sie grösser als ~0.8 MB sind
const UNDO_MS = 6000;
const POLL_ACTIVE_MS = 15000;
const POLL_BACKGROUND_MS = 90000;
const DOWNLOAD_CONCURRENCY = 6;
const BOARD_COLORS = [
  '#d9a827','#4a90d9','#5cb85c','#c1443a','#7a5c8e','#e07b39','#2c2c2c',
  '#2f9e8f','#d94f92','#8bc34a','#5c6bc0','#c9c9c9'
];
