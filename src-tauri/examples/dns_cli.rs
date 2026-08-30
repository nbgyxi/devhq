//! Headless smoke test for the DNS tool, so the resolver, the resolver
//! comparison and the hosts-file reader can be exercised without launching the
//! window: `cargo run --example dns_cli -- example.com`
fn main() {
    let name = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "example.com".into());

    println!("system resolvers: {:?}", devhq_lib::dns::system_resolvers());

    let lookup = devhq_lib::dns::lookup(&name, "", &[]);
    println!(
        "\n{} via {} ({}) in {}ms — {}",
        lookup.name,
        lookup.server_label,
        lookup.server,
        lookup.ms,
        if lookup.error.is_empty() {
            lookup.rcode.clone()
        } else {
            lookup.error.clone()
        }
    );
    for record in &lookup.records {
        println!(
            "  {:<6} {:<7} {}{}",
            record.rtype,
            record.ttl,
            record.value,
            if record.note.is_empty() {
                String::new()
            } else {
                format!("   [{}]", record.note)
            }
        );
    }

    println!("\nresolvers:");
    for answer in devhq_lib::dns::compare(&name, "A") {
        println!(
            "  {:<12} {:<16} {:>5}ms  {}",
            answer.name,
            answer.ip,
            answer.ms,
            if answer.error.is_empty() {
                answer.answers.join(", ")
            } else {
                answer.error
            }
        );
    }

    if let Some(first) = devhq_lib::dns::lookup(&name, "", &["A".into()])
        .records
        .first()
    {
        let back = devhq_lib::dns::reverse(&first.value);
        println!(
            "\nreverse of {}: {}",
            first.value,
            back.records
                .first()
                .map(|r| r.value.clone())
                .unwrap_or_else(|| back.error.clone())
        );
    }

    let hosts = devhq_lib::dns::hosts_read();
    println!(
        "\n{} — {} lines, writable: {}, elevated: {}, {} backups",
        hosts.path,
        hosts.lines.len(),
        hosts.writable,
        hosts.elevated,
        hosts.backups.len()
    );
    for line in hosts.lines.iter().filter(|l| l.kind == "entry") {
        println!(
            "  [{}] {:<16} {}",
            if line.enabled { "on " } else { "off" },
            line.ip,
            line.names.join(" ")
        );
    }

    // Second argument, or this repository, so the config scan has something real to read.
    let here = std::env::args().nth(2).unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    });
    let domains = devhq_lib::dns::project_domains(vec![here.clone()], vec![String::new()]);
    println!("\nnames found in {here}: {}", domains.len());
    for row in domains {
        println!("  {:<20} {:<32} {}", row.project, row.host, row.note);
    }
}
