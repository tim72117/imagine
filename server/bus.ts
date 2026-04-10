import { EventEmitter } from 'events';

// 全域訊息匯流排，用於協調非同步任務的喚醒
export const commandQueue: any[] = [];
export const queueChanged = new EventEmitter();
