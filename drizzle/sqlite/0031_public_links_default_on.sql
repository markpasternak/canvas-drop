-- SQLite cannot ALTER COLUMN defaults without rebuilding the table. Avoid a live
-- users-table rewrite; the application insert path now writes can_publish_public=true
-- explicitly for future users.
SELECT 1;
