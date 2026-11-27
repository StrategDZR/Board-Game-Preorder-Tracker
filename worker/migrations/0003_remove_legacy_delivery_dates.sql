WITH entries AS (
  SELECT entry.key AS position, entry.value AS game, json_extract(entry.value, '$.eta') AS eta
  FROM catalog, json_each(catalog.games) AS entry
  WHERE catalog.id = 1
),
checked AS (
  SELECT position, game, (
    json_type(game, '$.eta') IS NOT NULL AND eta IS NOT '' AND (
      typeof(eta) <> 'text' OR substr(eta, 1, 4) = '0000' OR NOT (
        (eta GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(eta, '+0 days') IS eta) OR
        (eta GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND date(eta || '-01', '+0 days') IS (eta || '-01'))
      )
    )
  ) AS invalid_eta
  FROM entries
)
UPDATE catalog
SET games = (
  SELECT json_group_array(json(game))
  FROM (
    SELECT CASE WHEN invalid_eta THEN json_remove(game, '$.eta') ELSE game END AS game
    FROM checked
    ORDER BY position
  )
), revision = revision + 1
WHERE id = 1 AND EXISTS (SELECT 1 FROM checked WHERE invalid_eta);
