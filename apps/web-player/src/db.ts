/**
 * État local du Player Web dans IndexedDB (WEBPLY-001, WEBPLY-002) : installation,
 * clé, association, Display, manifests reçus (enveloppes signées), outbox des états de
 * livraison, file d’événements et journal des commandes. Un effacement des données du site supprime tout : nouvelle installation.
 */
const DB_NAME = 'pixlova-player';
const DB_VERSION = 2;

export type Store = 'kv' | 'manifests' | 'outbox' | 'assets' | 'events' | 'commands';

let opening: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB'));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Migrations additives uniquement, comme le Player natif.
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('manifests')) db.createObjectStore('manifests');
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
      // Version 2 (ADR-014) : file d’événements et journal des commandes.
      if (!db.objectStoreNames.contains('events')) {
        db.createObjectStore('events', { keyPath: 'local_id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('commands')) {
        db.createObjectStore('commands', { keyPath: 'command_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB indisponible'));
    req.onblocked = () => reject(new Error('IndexedDB bloquée par un autre onglet'));
  });
  return opening;
}

async function tx<T>(
  store: Store,
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  const transaction = db.transaction(store, mode);
  const result = request(run(transaction.objectStore(store)));
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('transaction'));
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction annulée'));
  });
  return result;
}

export const idb = {
  get<T>(store: Store, key: IDBValidKey): Promise<T | undefined> {
    return tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  put(store: Store, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
    return tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
  },
  delete(store: Store, key: IDBValidKey): Promise<undefined> {
    return tx(store, 'readwrite', (s) => s.delete(key));
  },
  all<T>(store: Store): Promise<T[]> {
    return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  keys(store: Store): Promise<IDBValidKey[]> {
    return tx(store, 'readonly', (s) => s.getAllKeys());
  },
};
