#[tokio::main]
async fn main() {
    if let Err(error) = voice_media_rs::http::serve_from_env().await {
        eprintln!("voice-media-rs startup failed: {error}");
        std::process::exit(1);
    }
}
