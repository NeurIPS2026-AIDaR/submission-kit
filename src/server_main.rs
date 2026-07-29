#[tokio::main]
async fn main() {
    if let Err(error) = aidar::operator::serve().await {
        eprintln!("ERROR: {error:#}");
        std::process::exit(1);
    }
}
