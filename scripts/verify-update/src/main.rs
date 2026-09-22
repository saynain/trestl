use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::Path};

fn decode(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    Ok(String::from_utf8(
        STANDARD.decode(fs::read_to_string(path)?.trim())?,
    )?)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() < 2 {
        return Err("Usage: trestl-verify-update <public-key> <artifact>...".into());
    }
    let key = PublicKey::decode(&decode(Path::new(&args[0]))?)?;
    for artifact in &args[1..] {
        let mut signature_path = artifact.clone();
        signature_path.push(".sig");
        let signature = Signature::decode(&decode(Path::new(&signature_path))?)?;
        key.verify(&fs::read(artifact)?, &signature, true)?;
        println!("Verified {}", Path::new(artifact).display());
    }
    Ok(())
}
