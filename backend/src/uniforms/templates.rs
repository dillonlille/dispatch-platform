use crate::{Result, crypto, db::Db};
use rusqlite::params;

pub(super) fn insert(db: &Db, revision: i64) -> Result<()> {
    let sizes = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"];
    let apparel = &["men", "women"][..];
    let unisex = &["unisex"][..];
    let starter = [
        ("Tops", "Short Sleeve Polo", &sizes[..], apparel),
        ("Tops", "Long Sleeve Polo", &sizes[..7], apparel),
        ("Bottoms", "Shorts", &sizes[..], apparel),
        ("Bottoms", "Pants", &sizes[..], apparel),
        (
            "Vests",
            "Spare Vest",
            &["XS/S", "M/L", "XL", "2XL/3XL", "4XL/5XL"][..],
            unisex,
        ),
        ("Jackets", "Rainshell", &[][..], apparel),
        ("Jackets", "Softshell", &[][..], apparel),
        ("Hats", "Visor", &["One size"][..], unisex),
        ("Hats", "Beanie", &["One size"][..], unisex),
        ("Hats", "Bucket", &["One size"][..], unisex),
        ("Hats", "Snap Back", &["One size"][..], unisex),
    ];
    for (position, (category, name, sizes, fits)) in starter.iter().enumerate() {
        let id = crypto::id("uniform")?;
        db.exec(
            "INSERT INTO uniforms (id,name,category,revision,position) VALUES (?,?,?,?,?)",
            params![id, name, category, revision, position as i64],
        )?;
        for (size_position, size) in sizes.iter().enumerate() {
            for fit in *fits {
                db.exec("INSERT INTO uniform_variants (id,uniform_id,fit,size,revision,position) VALUES (?,?,?,?,?,?)",
                    params![crypto::id("size")?,id,fit,size,revision,size_position as i64])?;
            }
        }
    }
    Ok(())
}
