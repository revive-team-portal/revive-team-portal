-- Scorecard · SwiftPOS discovery queries. Run each in a New Query (database = SWIFTPOS).
-- After each, right-click the grid -> Select All -> Copy with Headers, then paste it
-- into the "Paste results" box at team.revive.co.nz/pos/.

-- STEP 1  Tables with sales/product data
SELECT t.name AS table_name, p.rows AS row_count
FROM sys.tables t JOIN sys.partitions p ON p.object_id=t.object_id AND p.index_id IN (0,1)
WHERE t.name LIKE '%tran%' OR t.name LIKE '%sale%' OR t.name LIKE '%item%'
   OR t.name LIKE '%group%' OR t.name LIKE '%dept%' OR t.name LIKE '%product%'
   OR t.name LIKE '%stock%' OR t.name LIKE '%plu%'
ORDER BY p.rows DESC;

-- STEP 4  Columns of all EJ tables (to find the sale date + Transaction_Number link)
SELECT c.TABLE_NAME, c.ORDINAL_POSITION AS pos, c.COLUMN_NAME, c.DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_NAME LIKE 'EJ%'
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;
