-- 서버가 시작할 때마다 자동으로 실행된다. 이미 있는 테이블은 건드리지 않는다.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  nickname      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_nickname_key ON users (lower(nickname));

CREATE TABLE IF NOT EXISTS characters (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  gender       TEXT NOT NULL,
  element      TEXT NOT NULL,
  class        TEXT NOT NULL,
  god          TEXT NOT NULL,
  level        INT NOT NULL DEFAULT 1,
  exp          INT NOT NULL DEFAULT 0,
  gold         INT NOT NULL DEFAULT 0,
  str          INT NOT NULL,
  mag          INT NOT NULL,
  vit          INT NOT NULL,
  agi          INT NOT NULL,
  luk          INT NOT NULL,
  stat_points  INT NOT NULL DEFAULT 0,
  hp           INT NOT NULL,
  mp           INT NOT NULL,
  location_id  TEXT NOT NULL,
  profile_text TEXT NOT NULL DEFAULT '',
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS characters_name_key ON characters (lower(name));
CREATE INDEX IF NOT EXISTS characters_user_idx ON characters (user_id);

-- 아이템 "실물". item_code로 items.json 정의를 찾는다. (3단계부터)
CREATE TABLE IF NOT EXISTS items (
  id          BIGSERIAL PRIMARY KEY,
  owner_id    BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_code   TEXT NOT NULL,
  enhance     INT NOT NULL DEFAULT 0,
  is_equipped BOOLEAN NOT NULL DEFAULT false,
  slot        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_owner_idx ON items (owner_id);

-- 4단계: 장비 등급과 추가 옵션, 기본 장비 지급 여부. 이미 있는 DB에도 컬럼만 더한다.
ALTER TABLE items ADD COLUMN IF NOT EXISTS grade TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS starter_equipment BOOLEAN NOT NULL DEFAULT false;
