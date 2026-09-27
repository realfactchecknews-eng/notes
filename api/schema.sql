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

-- Опубликованные конспекты и сборники предметов
CREATE TABLE IF NOT EXISTS shares (
  code   TEXT PRIMARY KEY,
  uid    TEXT NOT NULL,
  kind   TEXT NOT NULL,          -- note | folder
  title  TEXT,
  author TEXT,
  json   TEXT NOT NULL,
  views  INTEGER DEFAULT 0,
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_uid ON shares(uid);

-- Группы одногруппников
CREATE TABLE IF NOT EXISTS groups (
  id    TEXT PRIMARY KEY,
  code  TEXT UNIQUE NOT NULL,
  name  TEXT NOT NULL,
  owner TEXT NOT NULL,
  ts    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  gid   TEXT NOT NULL,
  uid   TEXT NOT NULL,
  email TEXT,
  ts    INTEGER NOT NULL,
  PRIMARY KEY (gid, uid)
);
-- Что выложено в группу
CREATE TABLE IF NOT EXISTS posts (
  gid  TEXT NOT NULL,
  code TEXT NOT NULL,
  uid  TEXT NOT NULL,
  ts   INTEGER NOT NULL,
  PRIMARY KEY (gid, code)
);

-- Расход ИИ по пользователям и дням, чтобы держать бюджет
CREATE TABLE IF NOT EXISTS ai_use (
  uid    TEXT NOT NULL,
  day    TEXT NOT NULL,
  calls  INTEGER DEFAULT 0,
  tin    INTEGER DEFAULT 0,
  tout   INTEGER DEFAULT 0,
  PRIMARY KEY (uid, day)
);
