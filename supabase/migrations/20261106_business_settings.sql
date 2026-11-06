alter table public.khata_data
    drop constraint if exists khata_data_collection_check;

alter table public.khata_data
    add constraint khata_data_collection_check
    check (collection in ('customers', 'transactions', 'products', 'sales', 'settings'));
