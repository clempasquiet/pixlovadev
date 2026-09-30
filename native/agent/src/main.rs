//! Point d’entrée de l’agent natif pixlova.
//!
//! Le squelette ne contient encore ni appairage, ni cache, ni renderer (voir L06-N).
//! Il fixe le binaire, la chaîne d’outils et la CI Rust.

fn main() {
    println!("{}", version_line());
}

fn version_line() -> String {
    format!("pixlova-agent {}", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::version_line;

    #[test]
    fn affiche_la_version_du_paquet() {
        assert!(version_line().starts_with("pixlova-agent "));
    }
}
