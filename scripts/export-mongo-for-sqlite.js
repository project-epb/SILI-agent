// Run with mongosh against the frozen source database, or a restored archive.
for (const table of db.getCollectionNames().sort()) {
  const collection = db.getCollection(table)
  print(JSON.stringify({ table, count: collection.countDocuments({}) }))
  collection.find({}).forEach((row) => {
    print(EJSON.stringify({ row }, { relaxed: false }))
  })
}
