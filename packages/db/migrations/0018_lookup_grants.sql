-- Which clinic owns a dialled number, and which organization a person belongs to, are
-- looked up before the tenant is known, on the owner connection (clinicForNumber, and
-- Better Auth's organization plugin). The application role never reads these tables,
-- and they have no Row Level Security, so it keeps no grant on them.
--
-- clinics stays without FORCE: the owner reads it before the tenant is set (the number
-- lookup, clinicById, the staff guard), and FORCE would hide every row from an owner
-- that is not a superuser. The application role is still bound by clinics_self.
revoke select on organizations, phone_numbers from attendra_app;
