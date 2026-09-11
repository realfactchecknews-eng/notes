CREATE TABLE IF NOT EXISTS users (
  id     TEXT PRIMARY KEY,
  email  TEXT UNIQUE NOT NULL,
  hash   TEXT NOT NULL,          -- PBKDF2, соль внутри строки
  made   INTEGER NOT NULL
);

-- Папки, карточки, результаты тестов — одним JSON на пользователя
CREATE TABLE IF NOT EXISTS meta (
  uid  TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  ts   INTEGER NOT NULL
);

-- Каждый конспект отдельной строкой: так один тяжёлый конспект не тормозит остальные
CREATE TABLE IF NOT EXISTS notes (
  id    TEXT NOT NULL,
  uid   TEXT NOT NULL,
  title TEXT,
  html  TEXT,
  files TEXT,
  ts    INTEGER NOT NULL,
  PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS notes_uid ON notes(uid);
