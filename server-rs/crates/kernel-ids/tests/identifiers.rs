use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};

#[test]
fn tenant_and_cell_ids_preserve_the_existing_bounded_wire_grammar() {
    let tenant = TenantId::parse("tenant-a.example:1").expect("valid tenant id");
    let cell = CellId::parse("cell-cn-north-1").expect("valid cell id");

    assert_eq!(tenant.as_str(), "tenant-a.example:1");
    assert_eq!(cell.as_str(), "cell-cn-north-1");

    for invalid in ["", "-tenant", "tenant/name", "tenant\nother", "租户"] {
        assert!(TenantId::parse(invalid).is_err(), "accepted {invalid:?}");
        assert!(CellId::parse(invalid).is_err(), "accepted {invalid:?}");
    }

    let maximum = format!("a{}", "b".repeat(254));
    assert!(TenantId::parse(&maximum).is_ok());
    assert!(CellId::parse(&maximum).is_ok());
    assert!(TenantId::parse(format!("a{}", "b".repeat(255))).is_err());
    assert!(CellId::parse(format!("a{}", "b".repeat(255))).is_err());
}

#[test]
fn owner_epoch_uses_the_canonical_full_uint64_decimal_wire_form() {
    assert_eq!(OwnerEpoch::parse("0").expect("zero epoch").get(), 0);
    assert_eq!(
        OwnerEpoch::parse("18446744073709551615")
            .expect("u64 max")
            .to_string(),
        "18446744073709551615",
    );

    for invalid in ["", "00", "01", "+1", "-1", "1.0", "18446744073709551616"] {
        assert!(OwnerEpoch::parse(invalid).is_err(), "accepted {invalid:?}");
    }
}

#[test]
fn generation_is_positive_and_fails_closed_on_exhaustion() {
    assert!(Generation::new(0).is_err());
    let first = Generation::new(1).expect("first generation");
    assert_eq!(first.get(), 1);
    assert_eq!(first.next().expect("next generation").get(), 2);

    let exhausted = Generation::new(u64::MAX).expect("maximum generation");
    assert!(exhausted.next().is_err());
}
