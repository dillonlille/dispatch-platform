-- Where each dataset of a publication came from: the API, or the page's spreadsheet
-- when the API could not be read. Publications from before this have no rows here
-- and were read from the API.
CREATE TABLE IF NOT EXISTS scorecard_sources (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  dataset TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('api','csv')),
  url TEXT NOT NULL, row_count INTEGER NOT NULL,
  PRIMARY KEY(publication_id,dataset)
);
