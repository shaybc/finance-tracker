export function applyRulesToTransaction(db, txId) {
  const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId);
  if (!tx || tx.category_id) return false;

  console.log(`Checking transaction ${txId}: merchant="${tx.merchant}", description="${tx.description}", source="${tx.source}"`);

  const rules = db
    .prepare(
      "SELECT r.*, c.name_he AS category_name FROM rules r JOIN categories c ON c.id = r.category_id WHERE r.enabled = 1 ORDER BY r.id ASC"
    )
    .all();

  for (const rule of rules) {
    console.log(`  Testing rule "${rule.name}": field=${rule.match_field}, type=${rule.match_type}, pattern="${rule.pattern}"`);
    
    // Check source filter
    if (rule.source && rule.source !== tx.source) {
      console.log(`    Skipped: source filter (rule wants ${rule.source}, tx is ${tx.source})`);
      continue;
    }
    
    // Check direction filter
    if (rule.direction && rule.direction !== tx.direction) {
      console.log(`    Skipped: direction filter (rule wants ${rule.direction}, tx is ${tx.direction})`);
      continue;
    }

    // Get the field value to match against
    let fieldVal = "";
    
    if (rule.match_field === "merchant") {
      // For "תיאור/בית עסק": use merchant if exists, otherwise use description
      fieldVal = tx.merchant || tx.description || "";
    } else if (rule.match_field === "category_raw") {
      fieldVal = tx.category_raw || "";
    }

    // Skip if field is empty
    if (!fieldVal) {
      console.log(`    Skipped: no field value to search`);
      continue;
    }

    console.log(`    Searching in field value: "${fieldVal}"`);

    // Normalize both strings for comparison
    const normalizedField = String(fieldVal)
      .trim()
      .normalize("NFC")
      .toLowerCase();
    
    const normalizedPattern = String(rule.pattern)
      .trim()
      .normalize("NFC")
      .toLowerCase();

    console.log(`    Normalized field: "${normalizedField}"`);
    console.log(`    Normalized pattern: "${normalizedPattern}"`);

    let matched = false;

    if (rule.match_type === "contains") {
      matched = normalizedField.includes(normalizedPattern);
      console.log(`    Contains check: ${matched}`);
    } else if (rule.match_type === "equals") {
      matched = normalizedField === normalizedPattern;
      console.log(`    Equals check: ${matched}`);
    } else if (rule.match_type === "regex") {
      try {
        // For regex, use the normalized field but original pattern
        // Unicode flag 'u' is important for proper Hebrew handling
        const re = new RegExp(rule.pattern, "iu");
        matched = re.test(normalizedField);
        console.log(`    Regex check: ${matched}`);
      } catch (err) {
        console.error(`    Invalid regex pattern: ${rule.pattern}`, err);
        matched = false;
      }
    }

    if (matched) {
      db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").run(
        rule.category_id,
        tx.id
      );
      console.log(`    ✓ MATCHED! Applied category ${rule.category_name} to transaction ${tx.id}`);
      return true;
    }
    
    console.log(`    No match for this rule`);
  }

  console.log(`  No rules matched transaction ${txId}`);
  return false;
}