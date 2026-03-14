import './config';          // validates env vars early
import { connect, shutdown } from './connection';

connect();

process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT',  () => { shutdown(); process.exit(0); });
