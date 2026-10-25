CREATE TABLE IF NOT EXISTS seo_event_daily (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  page TEXT NOT NULL,
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  campaign TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, page, source, medium, campaign)
);

CREATE INDEX IF NOT EXISTS seo_event_daily_day_idx
  ON seo_event_daily (day);
