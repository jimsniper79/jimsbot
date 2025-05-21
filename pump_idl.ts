export type Pump = {
     version: string;
     name: string;
     instructions: Array<{
       name: string;
       accounts: Array<{ name: string; isMut: boolean; isSigner: boolean }>;
       args: Array<any>;
       discriminator: number[];
     }>;
   };

   export const IDL: Pump = {
     version: "0.1.0",
     name: "pump",
     instructions: [
       {
         name: "create",
         accounts: [
           { name: "mint", isMut: true, isSigner: true },
           // ... other accounts
         ],
         args: [
           // ... args
         ],
         discriminator: [
        24,
        30,
        200,
        40,
        5,
        28,
        7,
        119
      ]
       },
       // ... other instructions
     ],
     // ... rest of IDL
   };