use super::*;
use std::{collections::BTreeMap, path::PathBuf};
use ts_rs::TS;

macro_rules! exported {
    ($cfg:expr, $($ty:ty),* $(,)?) => {
        BTreeMap::from([$((
            <$ty>::output_path().expect("named type"),
            <$ty>::export_to_string($cfg).expect("exportable type")
                .lines().map(|line| format!("{}\n", line.trim_end())).collect::<String>(),
        )),*])
    };
}
fn bindings() -> BTreeMap<PathBuf, String> {
    let cfg = ts_rs::Config::new();
    exported!(
        &cfg,
        Cadence,
        UniformFit,
        UniformEventKind,
        UniformVariant,
        Uniform,
        UniformInventory,
        UniformAdjustment,
        UniformUpdates,
        UniformEvent,
        UniformHistory,
        DspProfile,
        JobMetrics,
        JobPhase,
        JobOutcome,
        PageRead,
        PageReads,
        PageStage,
        DocumentState,
        PaycomPreferences,
        PaycomPage,
        PaycomSort,
        PaycomColumn,
        NameOrder,
        PreferenceRevision,
        DepartmentOption,
        PaycomOptions,
        PaycomSettings,
        AuditArea,
        AuditSubject,
        AuditReference,
        AuditChange,
        AuditEvent,
        AuditName,
        AuditPage,
        AuditCount,
        BrowserAdmission,
        BrowserHealth,
        TransportHealth,
        MailHealth,
        PlatformHealth,
        Employee,
        Punch,
        InPunchKind,
        OutPunchKind,
        Timecard,
        EmployeeTimecard,
        DailyTimecard,
        DailyTimecards,
        EmployeesResponse,
        AssessedClock,
        Lunch,
        PunchEvent,
        PaycomDay,
        DeliveryGap,
        DeliveryGaps,
        MealPair,
        MealAssessment,
        MealStatus,
        LateRule,
        CortexMeal,
        MealPaycom,
        MealSource,
        MealEmployee,
        EmployeeLink,
        EmployeeLinks,
        MealRosterEmployee,
        MatchType,
        MealDriver,
        CortexPublication,
        MealComparison,
        CollectionChange,
        CollectionUpdates,
        CollectionSchedule,
        CollectionSchedules,
        Connection,
        ConnectionStatus,
        Dsp,
        DspStatus,
        DspSummary,
        DspView,
        EmployeeTimecardPeriod,
        EmployeeTimecardResponse,
        Environment,
        JobStatus,
        MailMessage,
        Member,
        OwnerStatus,
        Presence,
        ProviderMode,
        PublicJob,
        PublicUser,
        Role,
        RoleSummary,
        ScheduleCollection,
        SchedulePreview,
        SessionResponse,
        AccountSession,
    )
}
#[test]
fn typescript_contracts_match_the_rust_types() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../shared/contracts/generated");
    let bindings = bindings();
    if std::env::var_os("DISPATCH_UPDATE_CONTRACTS").is_some() {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (file, text) in &bindings {
            std::fs::write(dir.join(file), text).unwrap();
        }
    }
    let mut stored = BTreeMap::new();
    for entry in std::fs::read_dir(&dir).expect("shared/contracts/generated") {
        let path = entry.unwrap().path();
        let name = PathBuf::from(path.file_name().unwrap());
        stored.insert(name, std::fs::read_to_string(&path).unwrap());
    }
    assert!(
        stored == bindings,
        "shared/contracts/generated is out of date: run `npm run contracts:generate`"
    );
}
#[test]
fn the_job_kinds_written_for_typescript_are_the_registered_ones() {
    let kinds: Vec<_> = Provider::ALL
        .iter()
        .map(|p| format!("{:?}", p.job_kind()))
        .collect();
    let cfg = ts_rs::Config::new();
    assert!(
        PublicJob::export_to_string(&cfg)
            .unwrap()
            .contains(&kinds.join(" | "))
    );
}
