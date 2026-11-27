const DB = 'leapmore-records';
let connection: Promise<IDBDatabase> | undefined;

function open() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('datasets');
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
    req.onerror = () => reject(new Error('无法打开本地记录库。'));
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}

export async function readDataset<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction('datasets').objectStore('datasets').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(new Error('本地记录读取失败。'));
  });
}

async function mutate(change: (store: IDBObjectStore) => void) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('datasets', 'readwrite');
    change(tx.objectStore('datasets'));
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error('本地记录保存失败。'));
  });
}
export const saveDataset = (key: string, value: unknown) => mutate(store => store.put(value, key));
export const deleteDataset = (key: string) => mutate(store => store.delete(key));
export const deleteDatasetsWithPrefix = (prefix: string) => mutate(store => store.delete(IDBKeyRange.bound(prefix, prefix + '\uffff')));

export async function updateDataset<T>(key: string, update: (value: T | undefined) => T): Promise<T> {
  let value: T;
  await mutate(store => {
    const request = store.get(key);
    request.onsuccess = () => {
      value = update(request.result as T | undefined);
      store.put(value, key);
    };
  });
  return value!;
}

export function readSetting<T>(key: string, initial: T): T {
  try { return JSON.parse(localStorage.getItem('leapmore.' + key) ?? 'null') ?? initial; }
  catch { return initial; }
}
export function saveSetting(key: string, value: unknown) {
  localStorage.setItem('leapmore.' + key, JSON.stringify(value));
}
