import { EventEmitter } from 'events';
import { Task } from './types.js';

export class AppStore extends EventEmitter {
    private state: Map<string, any>;
    constructor() {
        super();
        this.state = new Map();
        this.state.set('tasks', new Map<string, Task>());
    }

    setState(updater: (state: Map<string, any>) => void | any) {
        if (typeof updater === 'function') {
            updater(this.state);
            this.emit('state_update', { global: true });
        }
    }

    getState() {
        return this.state;
    }
}

export const appStore = new AppStore();
export const onStateUpdate = (callback: any) => appStore.on('state_update', callback);
