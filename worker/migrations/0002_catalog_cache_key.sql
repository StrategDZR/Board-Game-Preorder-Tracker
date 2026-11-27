CREATE TABLE IF NOT EXISTS catalog_cache_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_hex TEXT NOT NULL CHECK (length(key_hex) = 64)
);
