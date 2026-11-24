// Entry point. Restores the database from Telegram first (when the disk is empty),
// then loads the app, which opens the database.
import './config.js';
import { restoreIfMissing, startBackups, startKeepAlive } from './backup.js';

await restoreIfMissing();
await import('./app.js');
await startBackups();
startKeepAlive();
